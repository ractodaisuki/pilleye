"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type CvModule = any;

type Detection = {
  x: number;
  y: number;
  radius: number;
};

type QualityStatus = {
  isTooDark: boolean;
  isBlurry: boolean;
  hasLargeOverlapRisk: boolean;
};

const ANALYSIS_INTERVAL_MS = 400;
const ANALYSIS_MAX_WIDTH = 480;
const HISTORY_SIZE = 3;
const OPENCV_SOURCES = [
  "https://docs.opencv.org/4.10.0/opencv.js",
  "https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.12.0-release.1/dist/opencv.js",
];
const OPENCV_LOAD_TIMEOUT_MS = 30000;

function median(values: number[]) {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function resolveCvRuntime(cv: CvModule): Promise<CvModule> {
  if (cv?.Mat) {
    return Promise.resolve(cv);
  }

  if (typeof cv?.then === "function") {
    return cv.then((resolvedCv: CvModule) => resolveCvRuntime(resolvedCv));
  }

  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      reject(new Error("OpenCV.js の初期化がタイムアウトしました。"));
    }, OPENCV_LOAD_TIMEOUT_MS);

    const previousInitializer = cv?.onRuntimeInitialized;
    if (cv) {
      cv.onRuntimeInitialized = () => {
        if (typeof previousInitializer === "function") {
          previousInitializer();
        }
        window.clearTimeout(timeout);
        resolve(cv);
      };
    } else {
      reject(new Error("OpenCV.js did not expose window.cv."));
    }
  });
}

function waitForOpenCvGlobal(): Promise<CvModule> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      const cv = (window as Window & { cv?: CvModule }).cv;
      if (cv) {
        window.clearInterval(timer);
        resolveCvRuntime(cv).then(resolve).catch(reject);
        return;
      }

      if (Date.now() - startedAt > OPENCV_LOAD_TIMEOUT_MS) {
        window.clearInterval(timer);
        reject(new Error("OpenCV.js did not expose window.cv."));
      }
    }, 100);
  });
}

async function loadOpenCv(): Promise<CvModule> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("OpenCV.js can only be loaded in a browser."));
  }

  const existingCv = (window as Window & { cv?: CvModule }).cv;
  if (existingCv) {
    return resolveCvRuntime(existingCv);
  }

  let lastError: Error | null = null;

  for (const source of OPENCV_SOURCES) {
    try {
      const existingScript = document.querySelector<HTMLScriptElement>(`script[src="${source}"]`);

      await new Promise<void>((resolve, reject) => {
        if (existingScript?.dataset.loaded === "true") {
          resolve();
          return;
        }

        const script = existingScript ?? document.createElement("script");
        const timeout = window.setTimeout(() => {
          reject(new Error(`OpenCV.js load timed out: ${source}`));
        }, OPENCV_LOAD_TIMEOUT_MS);

        script.addEventListener(
          "load",
          () => {
            window.clearTimeout(timeout);
            script.dataset.loaded = "true";
            resolve();
          },
          { once: true },
        );
        script.addEventListener(
          "error",
          () => {
            window.clearTimeout(timeout);
            reject(new Error(`OpenCV.js failed to load: ${source}`));
          },
          { once: true },
        );

        if (!existingScript) {
          script.src = source;
          script.async = true;
          document.body.appendChild(script);
        }
      });

      return await waitForOpenCvGlobal();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("OpenCV.js failed to load.");
    }
  }

  throw lastError ?? new Error("OpenCV.js failed to load.");
}

function getWarnings(quality: QualityStatus, countHistory: number[]) {
  const warnings: string[] = [];

  if (quality.isTooDark) {
    warnings.push("照明不足の可能性があります。明るい場所で再計測してください。");
  }

  if (quality.isBlurry) {
    warnings.push("映像がブレています。カメラとトレーを固定してください。");
  }

  if (quality.hasLargeOverlapRisk) {
    warnings.push("重なりや接触の可能性があります。錠剤を離して並べてください。");
  }

  if (countHistory.length >= HISTORY_SIZE && Math.max(...countHistory) - Math.min(...countHistory) >= 3) {
    warnings.push("検出数が安定していません。背景とのコントラストを確認してください。");
  }

  return warnings;
}

export default function Home() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const analysisCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const cvRef = useRef<CvModule | null>(null);
  const intervalRef = useRef<number | null>(null);
  const isAnalyzingRef = useRef(false);
  const isPausedRef = useRef(false);
  const historyRef = useRef<number[]>([]);

  const [cvStatus, setCvStatus] = useState<"loading" | "ready" | "error">("loading");
  const [cameraStatus, setCameraStatus] = useState<"idle" | "starting" | "ready" | "error">("idle");
  const [isPaused, setIsPaused] = useState(false);
  const [stableCount, setStableCount] = useState(0);
  const [rawCount, setRawCount] = useState(0);
  const [detections, setDetections] = useState<Detection[]>([]);
  const [quality, setQuality] = useState<QualityStatus>({
    isTooDark: false,
    isBlurry: false,
    hasLargeOverlapRisk: false,
  });
  const [confirmedCount, setConfirmedCount] = useState<number | null>(null);
  const [countHistory, setCountHistory] = useState<number[]>([]);
  const [errorMessage, setErrorMessage] = useState("");

  const warnings = useMemo(() => getWarnings(quality, countHistory), [countHistory, quality]);

  useEffect(() => {
    isPausedRef.current = isPaused;
  }, [isPaused]);

  useEffect(() => {
    let isMounted = true;

    loadOpenCv()
      .then((cv) => {
        if (!isMounted) {
          return;
        }
        cvRef.current = cv;
        setCvStatus("ready");
      })
      .catch((error: Error) => {
        if (!isMounted) {
          return;
        }
        setCvStatus("error");
        setErrorMessage(`${error.message} カメラ起動は可能ですが、解析は実行できません。`);
      });

    return () => {
      isMounted = false;
    };
  }, []);

  const stopCamera = useCallback(() => {
    if (intervalRef.current) {
      window.clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setCameraStatus("idle");
  }, []);

  useEffect(() => stopCamera, [stopCamera]);

  const drawOverlay = useCallback((items: Detection[]) => {
    const video = videoRef.current;
    const overlay = overlayRef.current;
    if (!video || !overlay || video.videoWidth === 0 || video.videoHeight === 0) {
      return;
    }

    overlay.width = video.videoWidth;
    overlay.height = video.videoHeight;

    const context = overlay.getContext("2d");
    if (!context) {
      return;
    }

    context.clearRect(0, 0, overlay.width, overlay.height);
    context.lineWidth = Math.max(4, Math.round(video.videoWidth / 180));
    context.strokeStyle = "#00e0a4";
    context.fillStyle = "rgba(0, 224, 164, 0.14)";

    items.forEach((item, index) => {
      context.beginPath();
      context.arc(item.x, item.y, item.radius, 0, Math.PI * 2);
      context.fill();
      context.stroke();

      context.font = `${Math.max(22, Math.round(item.radius * 0.7))}px system-ui`;
      context.fillStyle = "#ffffff";
      context.strokeStyle = "rgba(0, 0, 0, 0.7)";
      context.lineWidth = 5;
      const label = String(index + 1);
      context.strokeText(label, item.x - item.radius * 0.28, item.y + item.radius * 0.25);
      context.fillText(label, item.x - item.radius * 0.28, item.y + item.radius * 0.25);
      context.strokeStyle = "#00e0a4";
      context.fillStyle = "rgba(0, 224, 164, 0.14)";
    });
  }, []);

  const analyzeFrame = useCallback(() => {
    const cv = cvRef.current;
    const video = videoRef.current;
    const analysisCanvas = analysisCanvasRef.current;
    if (!cv || !video || !analysisCanvas || isAnalyzingRef.current || video.videoWidth === 0) {
      return;
    }

    isAnalyzingRef.current = true;

    const sourceWidth = video.videoWidth;
    const sourceHeight = video.videoHeight;
    const scale = Math.min(1, ANALYSIS_MAX_WIDTH / sourceWidth);
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));

    analysisCanvas.width = width;
    analysisCanvas.height = height;

    const context = analysisCanvas.getContext("2d", { willReadFrequently: true });
    if (!context) {
      isAnalyzingRef.current = false;
      return;
    }

    context.drawImage(video, 0, 0, width, height);

    let src: CvModule | null = null;
    let gray: CvModule | null = null;
    let blurred: CvModule | null = null;
    let thresh: CvModule | null = null;
    let contours: CvModule | null = null;
    let hierarchy: CvModule | null = null;
    let laplacian: CvModule | null = null;
    let mean = 0;
    let blurScore = 0;
    const nextDetections: Detection[] = [];

    try {
      src = cv.imread(analysisCanvas);
      gray = new cv.Mat();
      blurred = new cv.Mat();
      thresh = new cv.Mat();
      contours = new cv.MatVector();
      hierarchy = new cv.Mat();
      laplacian = new cv.Mat();

      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      mean = cv.mean(gray)[0];
      cv.Laplacian(gray, laplacian, cv.CV_64F);
      const lapMean = new cv.Mat();
      const lapStd = new cv.Mat();
      cv.meanStdDev(laplacian, lapMean, lapStd);
      blurScore = lapStd.doubleAt(0, 0) ** 2;
      lapMean.delete();
      lapStd.delete();

      cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
      cv.adaptiveThreshold(
        blurred,
        thresh,
        255,
        cv.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv.THRESH_BINARY_INV,
        31,
        4,
      );

      const kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5));
      cv.morphologyEx(thresh, thresh, cv.MORPH_OPEN, kernel);
      cv.morphologyEx(thresh, thresh, cv.MORPH_CLOSE, kernel);
      kernel.delete();

      cv.findContours(thresh, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

      const minArea = width * height * 0.00045;
      const maxArea = width * height * 0.08;
      let largestArea = 0;

      for (let index = 0; index < contours.size(); index += 1) {
        const contour = contours.get(index);
        const area = cv.contourArea(contour);
        largestArea = Math.max(largestArea, area);

        if (area < minArea || area > maxArea) {
          contour.delete();
          continue;
        }

        const perimeter = cv.arcLength(contour, true);
        if (perimeter <= 0) {
          contour.delete();
          continue;
        }

        const circularity = (4 * Math.PI * area) / (perimeter * perimeter);
        const rect = cv.boundingRect(contour);
        const aspectRatio = rect.width / Math.max(rect.height, 1);
        const normalizedRatio = aspectRatio > 1 ? aspectRatio : 1 / Math.max(aspectRatio, 0.01);

        if (circularity < 0.52 || normalizedRatio > 2.1) {
          contour.delete();
          continue;
        }

        const enclosing = cv.minEnclosingCircle(contour);
        nextDetections.push({
          x: enclosing.center.x / scale,
          y: enclosing.center.y / scale,
          radius: Math.max(enclosing.radius / scale, 14),
        });
        contour.delete();
      }

      nextDetections.sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y));

      const nextHistory = [...historyRef.current, nextDetections.length].slice(-HISTORY_SIZE);
      historyRef.current = nextHistory;
      const nextStableCount = median(nextHistory);

      setDetections(nextDetections);
      setRawCount(nextDetections.length);
      setStableCount(nextStableCount);
      setCountHistory(nextHistory);
      setQuality({
        isTooDark: mean < 55 || mean > 235,
        isBlurry: blurScore < 55,
        hasLargeOverlapRisk: largestArea > maxArea * 0.72,
      });
      drawOverlay(nextDetections);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "解析中にエラーが発生しました。");
    } finally {
      src?.delete();
      gray?.delete();
      blurred?.delete();
      thresh?.delete();
      contours?.delete();
      hierarchy?.delete();
      laplacian?.delete();
      isAnalyzingRef.current = false;
    }
  }, [drawOverlay]);

  const startCamera = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraStatus("error");
      setErrorMessage("このブラウザはカメラ取得に対応していません。");
      return;
    }

    try {
      stopCamera();
      setCameraStatus("starting");
      setErrorMessage("");
      setConfirmedCount(null);
      historyRef.current = [];
      setCountHistory([]);
      setStableCount(0);
      setRawCount(0);
      setDetections([]);

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });

      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) {
        throw new Error("video 要素を初期化できませんでした。");
      }

      video.srcObject = stream;
      await video.play();
      setCameraStatus("ready");
      setIsPaused(false);

      window.setTimeout(analyzeFrame, 200);
      intervalRef.current = window.setInterval(() => {
        if (!isPausedRef.current) {
          analyzeFrame();
        }
      }, ANALYSIS_INTERVAL_MS);
    } catch (error) {
      setCameraStatus("error");
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "カメラを起動できませんでした。ブラウザの権限を確認してください。",
      );
    }
  }, [analyzeFrame, stopCamera]);

  const resetMeasurement = useCallback(() => {
    historyRef.current = [];
    setCountHistory([]);
    setStableCount(0);
    setRawCount(0);
    setConfirmedCount(null);
    setDetections([]);
    setQuality({
      isTooDark: false,
      isBlurry: false,
      hasLargeOverlapRisk: false,
    });
    drawOverlay([]);
    if (cameraStatus === "ready") {
      analyzeFrame();
    }
  }, [analyzeFrame, cameraStatus, drawOverlay]);

  const togglePause = useCallback(() => {
    setIsPaused((current) => !current);
  }, []);

  const confirmCount = useCallback(() => {
    setConfirmedCount(stableCount);
  }, [stableCount]);

  const statusLabel = cvStatus === "ready" ? "解析準備完了" : cvStatus === "error" ? "カメラのみ利用可" : "解析読込中";
  const canStartCamera = cameraStatus !== "starting";
  const canUseMeasurement = cameraStatus === "ready";

  return (
    <main className="appShell">
      <section className="countHeader" aria-live="polite">
        <div>
          <p className="eyebrow">現在の推定個数</p>
          <strong className="countValue">{stableCount}</strong>
        </div>
        <div className="statusPill">{statusLabel}</div>
      </section>

      <section className="cameraPanel" aria-label="リアルタイムカウント">
        <div className="cameraFrame">
          <video ref={videoRef} className="cameraVideo" muted playsInline />
          <canvas ref={overlayRef} className="overlayCanvas" aria-hidden="true" />
          {cameraStatus !== "ready" ? (
            <div className="cameraPlaceholder">
              <span>背面カメラを起動して、白または黒のトレー上のバラ錠を映してください。</span>
            </div>
          ) : null}
        </div>
        <canvas ref={analysisCanvasRef} className="analysisCanvas" aria-hidden="true" />
      </section>

      <section className="controls" aria-label="操作">
        <button className="primaryButton" type="button" onClick={startCamera} disabled={!canStartCamera}>
          {cameraStatus === "starting" ? "起動中" : cameraStatus === "ready" ? "カメラ再起動" : "カメラ起動"}
        </button>
        <button className="secondaryButton" type="button" onClick={togglePause} disabled={!canUseMeasurement}>
          {isPaused ? "再開" : "一時停止"}
        </button>
        <button className="confirmButton" type="button" onClick={confirmCount} disabled={!canUseMeasurement}>
          この結果で確定
        </button>
        <button className="secondaryButton" type="button" onClick={resetMeasurement} disabled={!canUseMeasurement}>
          再計測
        </button>
      </section>

      <section className="resultPanel" aria-live="polite">
        <div>
          <p className="metricLabel">直近検出</p>
          <p className="metricValue">{rawCount}</p>
        </div>
        <div>
          <p className="metricLabel">確定値</p>
          <p className="metricValue">{confirmedCount ?? "-"}</p>
        </div>
        <div>
          <p className="metricLabel">検出マーカー</p>
          <p className="metricValue">{detections.length}</p>
        </div>
      </section>

      <section className="noticePanel">
        <p className="safetyText">補助機能です。必ず目視確認してください。</p>
        <p>
          対象は、単一種類の錠剤を白または黒のトレー上に重ならないよう並べた状態です。PTPシート上の錠剤は対象外です。
        </p>
      </section>

      {warnings.length > 0 ? (
        <section className="warningPanel" aria-live="assertive">
          {warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </section>
      ) : null}

      {errorMessage ? (
        <section className="errorPanel" aria-live="assertive">
          {errorMessage}
        </section>
      ) : null}
    </main>
  );
}

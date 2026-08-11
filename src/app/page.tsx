"use client";

import { ChangeEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  DrawingUtils,
  FaceLandmarker,
  FilesetResolver,
  HandLandmarker,
  PoseLandmarker,
} from "@mediapipe/tasks-vision";
import { InferenceSession, Tensor } from "onnxruntime-web";

type Status = "ready" | "loading" | "running" | "error";
type Motion = { name: string; active: boolean };
type PpeBox = { x: number; y: number; width: number; height: number; score: number; label: string };

const POSE_MODEL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";
const HAND_MODEL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
const FACE_MODEL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";
const PPE_MODEL = "https://huggingface.co/Hexmon/vyra-yolo-ppe-detection/resolve/main/best.onnx";
const PPE_LABELS = ["FALL", "GLOVES", "GOGGLES", "HELMET", "LADDER", "MASK", "NO-GLOVES", "NO-GOGGLES", "NO-HELMET", "NO-MASK", "NO-VEST", "PERSON", "CONE", "VEST"];
const PPE_INTERVAL_MS = 1200;

function distance(a: { x: number; y: number }, b?: { x: number; y: number }) {
  return b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
}

export default function Home() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const poseRef = useRef<PoseLandmarker | null>(null);
  const handRef = useRef<HandLandmarker | null>(null);
  const faceRef = useRef<FaceLandmarker | null>(null);
  const ppeRef = useRef<InferenceSession | null>(null);
  const ppeBoxesRef = useRef<PpeBox[]>([]);
  const ppeBusyRef = useRef(false);
  const ppeLastRef = useRef(0);
  const rafRef = useRef<number>(0);
  const frameRef = useRef<() => void>(() => {});
  const previousRef = useRef<Record<string, { x: number; y: number }>>({});
  const [status, setStatus] = useState<Status>("ready");
  const [facingMode, setFacingMode] = useState<"user" | "environment">("user");
  const [message, setMessage] = useState("กดเริ่มกล้องเพื่อวิเคราะห์แบบเรียลไทม์");
  const [helmet, setHelmet] = useState<"unknown" | "likely" | "not-found">("unknown");
  const [motions, setMotions] = useState<Motion[]>([
    { name: "ใบหน้า", active: false }, { name: "แขน", active: false }, { name: "มือ", active: false }, { name: "ขา", active: false },
  ]);

  const stop = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    const stream = videoRef.current?.srcObject as MediaStream | null;
    stream?.getTracks().forEach((track) => track.stop());
    if (videoRef.current) videoRef.current.srcObject = null;
    setStatus("ready");
    setMessage("หยุดการวิเคราะห์แล้ว");
  }, []);

  useEffect(() => () => stop(), [stop]);

  const openCamera = async (mode: "user" | "environment") => {
    const video = videoRef.current;
    if (!video) return;
    const previousStream = video.srcObject as MediaStream | null;
    previousStream?.getTracks().forEach((track) => track.stop());
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: mode }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
  };

  const inspectHelmetColor = (ctx: CanvasRenderingContext2D, face: { x: number; y: number }[]) => {
    if (!face.length) return setHelmet("unknown");
    const xs = face.map((p) => p.x * ctx.canvas.width);
    const ys = face.map((p) => p.y * ctx.canvas.height);
    const minX = Math.max(0, Math.min(...xs) - 16);
    const width = Math.min(ctx.canvas.width - minX, Math.max(...xs) - Math.min(...xs) + 32);
    const top = Math.max(0, Math.min(...ys) - width * 0.95);
    const height = Math.min(ctx.canvas.height - top, width * 0.65);
    if (width < 8 || height < 8) return;
    const pixels = ctx.getImageData(minX, top, width, height).data;
    let helmetPixels = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const [r, g, b] = [pixels[i], pixels[i + 1], pixels[i + 2]];
      const yellow = r > 130 && g > 90 && b < 95 && r > b * 1.6;
      const orange = r > 150 && g > 55 && g < 165 && b < 80;
      const white = r > 190 && g > 190 && b > 185 && Math.max(r, g, b) - Math.min(r, g, b) < 42;
      if (yellow || orange || white) helmetPixels++;
    }
    setHelmet(helmetPixels / (pixels.length / 4) > 0.16 ? "likely" : "not-found");
  };

  const detectPpe = async (video: HTMLVideoElement, outputWidth: number, outputHeight: number) => {
    if (!ppeRef.current || ppeBusyRef.current || performance.now() - ppeLastRef.current < PPE_INTERVAL_MS) return;
    ppeBusyRef.current = true;
    try {
      const inputCanvas = document.createElement("canvas");
      inputCanvas.width = 640; inputCanvas.height = 640;
      const inputContext = inputCanvas.getContext("2d");
      if (!inputContext) return;
      inputContext.drawImage(video, 0, 0, 640, 640);
      const rgba = inputContext.getImageData(0, 0, 640, 640).data;
      const input = new Float32Array(3 * 640 * 640);
      for (let i = 0; i < 640 * 640; i++) {
        input[i] = rgba[i * 4] / 255;
        input[i + 640 * 640] = rgba[i * 4 + 1] / 255;
        input[i + 2 * 640 * 640] = rgba[i * 4 + 2] / 255;
      }
      const results = await ppeRef.current.run({ [ppeRef.current.inputNames[0]]: new Tensor("float32", input, [1, 3, 640, 640]) });
      const tensor = results[ppeRef.current.outputNames[0]];
      const [,, count] = tensor.dims;
      const data = tensor.data as Float32Array;
      const candidates: PpeBox[] = [];
      for (let i = 0; i < count; i++) {
        let labelIndex = 0; let score = 0;
        for (let cls = 0; cls < PPE_LABELS.length; cls++) {
          const value = data[(4 + cls) * count + i];
          if (value > score) { score = value; labelIndex = cls; }
        }
        if (score < 0.45) continue;
        const w = data[2 * count + i] / 640 * outputWidth;
        const h = data[3 * count + i] / 640 * outputHeight;
        candidates.push({ x: (data[i] / 640 * outputWidth) - w / 2, y: (data[count + i] / 640 * outputHeight) - h / 2, width: w, height: h, score, label: PPE_LABELS[labelIndex] });
      }
      candidates.sort((a, b) => b.score - a.score);
      const kept: PpeBox[] = [];
      for (const box of candidates) {
        const duplicate = kept.some((other) => {
          if (other.label !== box.label) return false;
          const overlap = Math.max(0, Math.min(box.x + box.width, other.x + other.width) - Math.max(box.x, other.x)) * Math.max(0, Math.min(box.y + box.height, other.y + other.height) - Math.max(box.y, other.y));
          return overlap / (box.width * box.height + other.width * other.height - overlap) > 0.45;
        });
        if (!duplicate) kept.push(box);
        if (kept.length >= 24) break;
      }
      ppeBoxesRef.current = kept;
    } catch (error) { console.error("PPE inference failed", error); }
    finally { ppeLastRef.current = performance.now(); ppeBusyRef.current = false; }
  };

  const drawPpeBoxes = (ctx: CanvasRenderingContext2D) => {
    ppeBoxesRef.current.forEach((box) => {
      const unsafe = box.label.startsWith("NO-");
      const color = unsafe ? "#ff5769" : box.label === "PERSON" ? "#57e5b8" : "#00dbff";
      ctx.strokeStyle = color; ctx.lineWidth = 3;
      ctx.strokeRect(box.x, box.y, box.width, box.height);
      ctx.font = "bold 14px Arial";
      const text = `${box.label} ${(box.score * 100).toFixed(0)}%`;
      const textWidth = ctx.measureText(text).width + 12;
      ctx.fillStyle = color; ctx.fillRect(box.x, Math.max(0, box.y - 23), textWidth, 22);
      ctx.fillStyle = "#061713"; ctx.fillText(text, box.x + 6, Math.max(15, box.y - 7));
    });
  };

  const frame = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || (!poseRef.current && !ppeRef.current) || video.readyState < 2) {
      rafRef.current = requestAnimationFrame(() => frameRef.current()); return;
    }
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    void detectPpe(video, canvas.width, canvas.height);
    const time = performance.now();
    const usePpeOnly = !!ppeRef.current;
    const pose = usePpeOnly ? [] : (poseRef.current?.detectForVideo(video, time).landmarks[0] ?? []);
    const hands = usePpeOnly ? [] : (handRef.current?.detectForVideo(video, time).landmarks ?? []);
    const faces = usePpeOnly ? [] : (faceRef.current?.detectForVideo(video, time).faceLandmarks ?? []);
    const draw = new DrawingUtils(ctx);
    if (pose.length) {
      draw.drawConnectors(pose, PoseLandmarker.POSE_CONNECTIONS, { color: "#4de1b2", lineWidth: 4 });
      draw.drawLandmarks(pose, { color: "#f9c74f", radius: 4 });
    }
    hands.forEach((landmarks) => {
      draw.drawConnectors(landmarks, HandLandmarker.HAND_CONNECTIONS, { color: "#69a8ff", lineWidth: 3 });
      draw.drawLandmarks(landmarks, { color: "#d1e1ff", radius: 3 });
    });
    faces.forEach((landmarks) => draw.drawLandmarks(landmarks, { color: "#ff89b8", radius: 1 }));
    drawPpeBoxes(ctx);
    if (faces[0]) inspectHelmetColor(ctx, faces[0]);

    if (!usePpeOnly) {
    const points: Record<string, { x: number; y: number } | undefined> = {
      "ใบหน้า": pose[0], "แขน": pose[15] ?? pose[16], "มือ": hands[0]?.[9], "ขา": pose[27] ?? pose[28],
    };
    setMotions(Object.entries(points).map(([name, point]) => {
      const previous = previousRef.current[name];
      const active = !!point && distance(point, previous) > 0.012;
      if (point) previousRef.current[name] = point;
      return { name, active };
    }));
    }
    rafRef.current = requestAnimationFrame(() => frameRef.current());
  }, []);

  useEffect(() => { frameRef.current = frame; }, [frame]);

  const start = async () => {
    try {
      setStatus("loading"); setMessage("กำลังโหลด AI Vision บนอุปกรณ์…");
      ppeRef.current ??= await InferenceSession.create(PPE_MODEL, { executionProviders: ["wasm"] });
      await openCamera(facingMode);
      setStatus("running"); setMessage("กำลังวิเคราะห์จากกล้อง — ภาพประมวลผลบนอุปกรณ์ของคุณ");
      rafRef.current = requestAnimationFrame(() => frameRef.current());
    } catch (error) {
      console.error(error); setStatus("error"); setMessage("ไม่สามารถเปิดกล้องหรือโหลดโมเดลได้ โปรดอนุญาตการใช้กล้องและลองใหม่");
    }
  };

  const switchCamera = async () => {
    if (status !== "running") return;
    const nextMode = facingMode === "user" ? "environment" : "user";
    try {
      cancelAnimationFrame(rafRef.current);
      setStatus("loading");
      await openCamera(nextMode);
      setFacingMode(nextMode);
      setStatus("running");
      setMessage(`กำลังวิเคราะห์จาก${nextMode === "user" ? "กล้องหน้า" : "กล้องหลัง"} — ภาพประมวลผลบนอุปกรณ์ของคุณ`);
      rafRef.current = requestAnimationFrame(() => frameRef.current());
    } catch (error) {
      console.error(error);
      setStatus("running");
      setMessage("ไม่พบกล้องที่ต้องการ หรือเบราว์เซอร์ไม่อนุญาตให้สลับกล้อง");
      rafRef.current = requestAnimationFrame(() => frameRef.current());
    }
  };

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setMessage(`เลือกไฟล์ ${file.name} แล้ว — โหมดไฟล์วิดีโอจะเพิ่มได้ในขั้นถัดไป`);
  };

  const helmetLabel = helmet === "likely" ? ["มีแนวโน้มสวมหมวก", "good"] : helmet === "not-found" ? ["ไม่พบหมวก", "bad"] : ["รอใบหน้าในภาพ", "neutral"];
  return <main>
    <section className="hero">
      <div><p className="eyebrow">SAFETY VISION · LOCAL AI</p><h1>มองเห็นความปลอดภัย<br /><em>ก่อนเกิดอันตราย</em></h1><p className="intro">ตรวจหมวกนิรภัยและการเคลื่อนไหวของใบหน้า แขน มือ และขา จากกล้องของคุณแบบเรียลไทม์</p></div>
      <div className="privacy"><span>●</span><div><b>Privacy by design</b><br />วิเคราะห์ในเบราว์เซอร์ ไม่อัปโหลดภาพวิดีโอ</div></div>
    </section>
    <section className="workspace">
      <div className="viewer">
        <video ref={videoRef} muted playsInline className={`${status === "running" ? "hidden" : ""} ${facingMode === "user" ? "mirror" : ""}`} />
        <canvas ref={canvasRef} className={`${status === "running" ? "" : "hidden"} ${facingMode === "user" ? "mirror" : ""}`} />
        {status !== "running" && <div className="empty"><div className="cameraIcon">◉</div><b>กล้องพร้อมใช้งาน</b><span>{status === "loading" ? "กำลังเตรียม AI Vision…" : "กดปุ่มด้านล่างเพื่อเริ่ม"}</span></div>}
        <div className="live"><i /> LIVE ANALYSIS</div>
      </div>
      <aside>
        <p className="panel-label">SAFETY STATUS</p>
        <div className={`helmet ${helmetLabel[1]}`}><span className="helmet-dot" /><div><small>HELMET CHECK</small><strong>{helmetLabel[0]}</strong><p>ตรวจจากสีบริเวณเหนือใบหน้า</p></div></div>
        <p className="panel-label movement-title">MOVEMENT TRACKING</p>
        <div className="motion-grid">{motions.map((motion) => <div className="motion" key={motion.name}><span className={motion.active ? "pulse" : ""} />{motion.name}<b>{motion.active ? "เคลื่อนไหว" : "นิ่ง"}</b></div>)}</div>
        <div className="note"><b>ข้อควรรู้สำหรับใช้งานจริง</b><br />การตรวจหมวกปัจจุบันเป็นการคัดกรองจากสีเท่านั้น ต้องเชื่อมต่อโมเดลหมวกนิรภัยที่ผ่านการทดสอบตามหน้างาน ก่อนใช้เป็นระบบแจ้งเตือนหรือบังคับใช้กฎ</div>
      </aside>
      {status === "running" && <button className="camera-switch" onClick={switchCamera}>สลับเป็น{facingMode === "user" ? "กล้องหลัง" : "กล้องหน้า"}</button>}
    </section>
    <section className="controls"><div className="message">{message}</div><div className="actions">{status === "running" ? <button className="secondary" onClick={stop}>หยุดกล้อง</button> : <button className="primary" onClick={start} disabled={status === "loading"}>{status === "loading" ? "กำลังเริ่ม…" : "เริ่มวิเคราะห์จากกล้อง"}</button>}<label className="upload">อัปโหลดวิดีโอ<input type="file" accept="video/*" onChange={onFile} /></label></div></section>
    <footer><span>SAFETY VISION</span><span>MediaPipe landmarks · client-side processing</span></footer>
  </main>;
}

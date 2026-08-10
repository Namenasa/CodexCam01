"use client";

import { ChangeEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  DrawingUtils,
  FaceLandmarker,
  FilesetResolver,
  HandLandmarker,
  PoseLandmarker,
} from "@mediapipe/tasks-vision";

type Status = "ready" | "loading" | "running" | "error";
type Motion = { name: string; active: boolean };

const POSE_MODEL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";
const HAND_MODEL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
const FACE_MODEL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";

function distance(a: { x: number; y: number }, b?: { x: number; y: number }) {
  return b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
}

export default function Home() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const poseRef = useRef<PoseLandmarker | null>(null);
  const handRef = useRef<HandLandmarker | null>(null);
  const faceRef = useRef<FaceLandmarker | null>(null);
  const rafRef = useRef<number>(0);
  const frameRef = useRef<() => void>(() => {});
  const previousRef = useRef<Record<string, { x: number; y: number }>>({});
  const [status, setStatus] = useState<Status>("ready");
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

  const frame = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !poseRef.current || video.readyState < 2) {
      rafRef.current = requestAnimationFrame(() => frameRef.current()); return;
    }
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const time = performance.now();
    const pose = poseRef.current.detectForVideo(video, time).landmarks[0] ?? [];
    const hands = handRef.current?.detectForVideo(video, time).landmarks ?? [];
    const faces = faceRef.current?.detectForVideo(video, time).faceLandmarks ?? [];
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
    if (faces[0]) inspectHelmetColor(ctx, faces[0]);

    const points: Record<string, { x: number; y: number } | undefined> = {
      "ใบหน้า": pose[0], "แขน": pose[15] ?? pose[16], "มือ": hands[0]?.[9], "ขา": pose[27] ?? pose[28],
    };
    setMotions(Object.entries(points).map(([name, point]) => {
      const previous = previousRef.current[name];
      const active = !!point && distance(point, previous) > 0.012;
      if (point) previousRef.current[name] = point;
      return { name, active };
    }));
    rafRef.current = requestAnimationFrame(() => frameRef.current());
  }, []);

  useEffect(() => { frameRef.current = frame; }, [frame]);

  const start = async () => {
    try {
      setStatus("loading"); setMessage("กำลังโหลด AI Vision บนอุปกรณ์…");
      const vision = await FilesetResolver.forVisionTasks(WASM);
      [poseRef.current, handRef.current, faceRef.current] = await Promise.all([
        PoseLandmarker.createFromOptions(vision, { baseOptions: { modelAssetPath: POSE_MODEL }, runningMode: "VIDEO", numPoses: 2 }),
        HandLandmarker.createFromOptions(vision, { baseOptions: { modelAssetPath: HAND_MODEL }, runningMode: "VIDEO", numHands: 4 }),
        FaceLandmarker.createFromOptions(vision, { baseOptions: { modelAssetPath: FACE_MODEL }, runningMode: "VIDEO", numFaces: 2 }),
      ]);
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      if (!videoRef.current) return;
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
      setStatus("running"); setMessage("กำลังวิเคราะห์จากกล้อง — ภาพประมวลผลบนอุปกรณ์ของคุณ");
      rafRef.current = requestAnimationFrame(() => frameRef.current());
    } catch (error) {
      console.error(error); setStatus("error"); setMessage("ไม่สามารถเปิดกล้องหรือโหลดโมเดลได้ โปรดอนุญาตการใช้กล้องและลองใหม่");
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
        <video ref={videoRef} muted playsInline className={status === "running" ? "hidden" : ""} />
        <canvas ref={canvasRef} className={status === "running" ? "" : "hidden"} />
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
    </section>
    <section className="controls"><div className="message">{message}</div><div className="actions">{status === "running" ? <button className="secondary" onClick={stop}>หยุดกล้อง</button> : <button className="primary" onClick={start} disabled={status === "loading"}>{status === "loading" ? "กำลังเริ่ม…" : "เริ่มวิเคราะห์จากกล้อง"}</button>}<label className="upload">อัปโหลดวิดีโอ<input type="file" accept="video/*" onChange={onFile} /></label></div></section>
    <footer><span>SAFETY VISION</span><span>MediaPipe landmarks · client-side processing</span></footer>
  </main>;
}

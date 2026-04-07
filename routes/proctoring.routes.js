import express from "express";
import firebaseAuth from "../middlewares/firebaseAuth.js";

const router = express.Router();

const ACTIVE_SESSION_TTL_MS = 10 * 60 * 1000;
const liveSessions = new Map();

const toSerializableSession = (session) => ({
  id: session.id,
  peerId: session.peerId,
  userName: session.userName,
  examId: session.examId,
  examTitle: session.examTitle,
  userId: session.userId,
  isSuspicious: Boolean(session.isSuspicious),
  isVoiceSuspicious: Boolean(session.isVoiceSuspicious),
  multipleFacesDetected: Boolean(session.multipleFacesDetected),
  noFaceDetected: Boolean(session.noFaceDetected),
  detections: Array.isArray(session.detections) ? session.detections : [],
  lastDetected: session.lastDetected || null,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
});

const pruneExpiredSessions = () => {
  const cutoff = Date.now() - ACTIVE_SESSION_TTL_MS;
  for (const [peerId, session] of liveSessions.entries()) {
    if (new Date(session.updatedAt).getTime() < cutoff) {
      liveSessions.delete(peerId);
    }
  }
};

router.post("/register", firebaseAuth, async (req, res) => {
  try {
    const { peerId, userName, examId, examTitle, userId } = req.body || {};

    if (!peerId) {
      return res.status(400).json({ message: "peerId is required" });
    }

    pruneExpiredSessions();

    const now = new Date().toISOString();
    const existing = liveSessions.get(peerId);
    const session = {
      id: peerId,
      peerId,
      userName: userName || req.firebase?.name || req.firebase?.email || "Student",
      examId: examId || existing?.examId || null,
      examTitle: examTitle || existing?.examTitle || "Exam",
      userId: userId || req.firebase?.uid || existing?.userId || null,
      isSuspicious: existing?.isSuspicious || false,
      isVoiceSuspicious: existing?.isVoiceSuspicious || false,
      multipleFacesDetected: existing?.multipleFacesDetected || false,
      noFaceDetected: existing?.noFaceDetected || false,
      detections: existing?.detections || [],
      lastDetected: existing?.lastDetected || null,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };

    liveSessions.set(peerId, session);
    res.status(200).json({ success: true, session: toSerializableSession(session) });
  } catch (error) {
    console.error("[PROCTORING] Register error:", error);
    res.status(500).json({ message: "Failed to register live session" });
  }
});

router.post("/status", firebaseAuth, async (req, res) => {
  try {
    const { peerId, status } = req.body || {};

    if (!peerId) {
      return res.status(400).json({ message: "peerId is required" });
    }

    pruneExpiredSessions();

    const now = new Date().toISOString();
    const existing = liveSessions.get(peerId) || {
      id: peerId,
      peerId,
      userName: req.firebase?.name || req.firebase?.email || "Student",
      examId: null,
      examTitle: "Exam",
      userId: req.firebase?.uid || null,
      createdAt: now,
    };

    const nextSession = {
      ...existing,
      isSuspicious: Boolean(status?.isSuspicious),
      isVoiceSuspicious: Boolean(status?.isVoiceSuspicious),
      multipleFacesDetected: Boolean(status?.multipleFacesDetected),
      noFaceDetected: Boolean(status?.noFaceDetected),
      detections: Array.isArray(status?.detections) ? status.detections : (existing.detections || []),
      lastDetected: status?.lastDetected || existing.lastDetected || null,
      updatedAt: now,
    };

    liveSessions.set(peerId, nextSession);
    res.status(200).json({ success: true, session: toSerializableSession(nextSession) });
  } catch (error) {
    console.error("[PROCTORING] Status error:", error);
    res.status(500).json({ message: "Failed to update live session" });
  }
});

router.get("/active", firebaseAuth, async (_req, res) => {
  try {
    pruneExpiredSessions();
    const sessions = Array.from(liveSessions.values())
      .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())
      .map(toSerializableSession);

    res.status(200).json(sessions);
  } catch (error) {
    console.error("[PROCTORING] Active sessions error:", error);
    res.status(500).json({ message: "Failed to fetch live sessions" });
  }
});

router.delete("/session/:peerId", firebaseAuth, async (req, res) => {
  try {
    const { peerId } = req.params;
    liveSessions.delete(peerId);
    res.status(200).json({ success: true });
  } catch (error) {
    console.error("[PROCTORING] Delete session error:", error);
    res.status(500).json({ message: "Failed to delete live session" });
  }
});

router.post("/cleanup", firebaseAuth, async (_req, res) => {
  try {
    const before = liveSessions.size;
    pruneExpiredSessions();
    const removed = before - liveSessions.size;
    res.status(200).json({ success: true, removed });
  } catch (error) {
    console.error("[PROCTORING] Cleanup error:", error);
    res.status(500).json({ message: "Failed to cleanup live sessions" });
  }
});

export default router;
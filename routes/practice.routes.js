import express from "express";
import multer from "multer";

import firebaseAuth from "../middlewares/firebaseAuth.js";
import attachUser from "../middlewares/attachUser.js";
import roleGuard from "../middlewares/roleGuard.js";

import {
  getChallenges,
  getChallengeById,
  createChallenge,
  deleteChallenge,
  bulkUploadChallenges,
  runPracticeCode,
  submitPracticeCode,
  getCompletedChallenges,
} from "../controllers/practice.controller.js";


const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "text/csv" || file.originalname.endsWith(".csv")) {
      cb(null, true);
    } else {
      cb(new Error("Only CSV files are allowed"));
    }
  },
  limits: {
    fileSize: 5 * 1024 * 1024, // 5 MB
  },
});

const router = express.Router();


router.use(firebaseAuth);
router.use(attachUser);


router.get("/", getChallenges);
router.get("/completed", getCompletedChallenges);   // v2 — completed challenges
router.post("/run", runPracticeCode);                // v2 — run code (sandbox)
router.post("/submit", submitPracticeCode);          // v2 — submit & evaluate
router.get("/:id", getChallengeById);                // must stay after static GETs


router.post("/", roleGuard("instructor", "admin"), createChallenge);
router.delete("/:id", roleGuard("instructor", "admin"), deleteChallenge);
router.post(                                         // v2 — CSV bulk upload
  "/bulk-upload",
  roleGuard("instructor", "admin"),
  upload.single("csvFile"),
  bulkUploadChallenges,
);

export default router;
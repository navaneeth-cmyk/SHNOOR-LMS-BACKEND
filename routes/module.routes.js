import express from "express";
import {
  addModules,
  getModulesByCourse,
  deleteModule,
  getModuleView,
  getModuleStream,
  advanceModuleStream,
  updateModuleTime
} from "../controllers/moduleController.js";

import firebaseAuth from "../middlewares/firebaseAuth.js";
import attachUser from "../middlewares/attachUser.js";
import roleGuard from "../middlewares/roleGuard.js";
import uploadPdf from "../middlewares/uploadPdf.js";
import { uploadBulk } from "../middlewares/uploadBulk.js";
import { bulkUploadModules } from "../controllers/modulebulk.controller.js";

const router = express.Router();

router.post(
  "/modules",
  firebaseAuth,
  attachUser,
  roleGuard("instructor"),
  (req, res, next) => {
    if (req.headers["content-type"]?.includes("multipart/form-data")) {
      return uploadPdf.array("pdfs")(req, res, next);
    }
    next();
  },
  addModules
);

router.get(
  "/courses/:courseId/modules",
  firebaseAuth,
  attachUser,
  getModulesByCourse
);

router.delete(
  "/:moduleId",
  firebaseAuth,
  attachUser,
  roleGuard("instructor"),
  deleteModule
);

router.get(
  "/modules/:moduleId/view",
  getModuleView
);

router.get(
  "/modules/:moduleId/pdf",
  (req, _res, next) => {
    req.query.type = "pdf";
    next();
  },
  getModuleView
);

router.get(
  "/modules/:moduleId/stream",
  firebaseAuth,
  attachUser,
  roleGuard("student", "learner", "instructor"),
  getModuleStream
);

router.post(
  "/modules/:moduleId/stream/next",
  firebaseAuth,
  attachUser,
  roleGuard("student", "learner", "instructor"),
  advanceModuleStream
);

router.post(
  "/modules/:moduleId/time",
  firebaseAuth,
  attachUser,
  roleGuard("student", "learner", "instructor"),
  updateModuleTime
);

router.post(
  "/modules/bulk-upload",
  firebaseAuth,
  attachUser,
  roleGuard("instructor"),
  uploadBulk,
  bulkUploadModules
);
export default router;
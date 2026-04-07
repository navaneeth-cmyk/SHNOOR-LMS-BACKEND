import express from "express";
import {
  addCourse,
  approveCourse,
  getPendingCourses,
  getApprovedCourses,
  getInstructorCourses,
  deleteCourse,
  getApprovedCoursesForInstructor,
  getInstructorCourseStats,
  getCourseById,
  exploreCourses,
  bulkUploadCourses,
  searchInstructorCoursesAndModules,
  unarchiveCourse,
  archiveCourse,
  rejectCourse,
  publishCourse,
  submitForReview,
  editModule,
  addModule
} from "../controllers/course.controller.js";

import firebaseAuth from "../middlewares/firebaseAuth.js";
import attachUser from "../middlewares/attachUser.js";
import roleGuard from "../middlewares/roleGuard.js";
import uploadCsv from "../middlewares/uploadCsv.js";
import { uploadFile } from "../controllers/upload.controller.js";

const router = express.Router();
const uploadModuleFile = (req, res, next) => {
  uploadFile(req, res, (err) => {
    if (err) {
      return res.status(400).json({ message: err.message });
    }
    next();
  });
};


router.post(
  "/",
  firebaseAuth,
  attachUser,
  roleGuard("instructor"),
  addCourse
);

router.get(
  "/instructor",
  firebaseAuth,
  attachUser,
  roleGuard("instructor"),
  getInstructorCourses
);

router.get(
  "/pending",
  firebaseAuth,
  attachUser,
  roleGuard("admin"),
  getPendingCourses
);

router.patch(
  "/:courseId/approve",
  firebaseAuth,
  attachUser,
  roleGuard("admin"),
  approveCourse
);

router.get(
  "/approved",
  firebaseAuth,
  attachUser,
  roleGuard("admin"),
  getApprovedCourses
);

router.delete(
  "/:courseId",
  firebaseAuth,
  attachUser,
  roleGuard("instructor"),
  deleteCourse
);

router.get(
  "/instructor/approved",
  firebaseAuth,
  attachUser,
  roleGuard("instructor"),
  getApprovedCoursesForInstructor
);

router.get(
  "/instructor/stats",
  firebaseAuth,
  attachUser,
  roleGuard("instructor"),
  getInstructorCourseStats
);

router.get(
  "/explore",
  firebaseAuth,
  attachUser,
  exploreCourses
);

router.get(
  "/:courseId",
  firebaseAuth,
  attachUser,
  getCourseById
);

router.post(
  "/bulk-upload",
  firebaseAuth,
  attachUser,
  roleGuard("instructor"),
  uploadCsv.single("file"),
  bulkUploadCourses
);

router.get(
  "/instructor/search",
  firebaseAuth,
  attachUser,
  roleGuard("instructor"),
  searchInstructorCoursesAndModules
);

router.patch(
  "/:courseId/submit-review",
  firebaseAuth,
  attachUser,
  roleGuard("instructor"),
  submitForReview
);

// Admin: Publish course (review → published)
router.patch(
  "/:courseId/publish",
  firebaseAuth,
  attachUser,
  roleGuard("admin"),
  publishCourse
);

// Admin: Reject course (review → draft)
router.patch(
  "/:courseId/reject",
  firebaseAuth,
  attachUser,
  roleGuard("admin"),
  rejectCourse
);

// Admin/Instructor: Archive course (published → archived)
router.patch(
  "/:courseId/archive",
  firebaseAuth,
  attachUser,
  roleGuard("admin", "instructor"),
  archiveCourse
);

// Admin/Instructor: Unarchive course (archived → published)
router.patch(
  "/:courseId/unarchive",
  firebaseAuth,
  attachUser,
  roleGuard("admin", "instructor"),
  unarchiveCourse
);

router.patch(
  "/modules/:moduleId",
  firebaseAuth,
  attachUser,
  roleGuard("instructor"),
  uploadModuleFile,
  editModule
);

router.post(
  "/:courseId/modules",
  firebaseAuth,
  attachUser,
  roleGuard("instructor"),
  uploadModuleFile,
  addModule
);

export default router;

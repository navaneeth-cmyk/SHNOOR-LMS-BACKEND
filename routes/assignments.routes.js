import express from "express";
import {
  assignCourseToStudent,
  assignCourseToGroup,
  unassignCourse,
  getMyCourses,
  getPublishedCourses,
  enrollCourse,
  getInstructorStudentCount,
  getInstructorEnrolledStudents,
} from "../controllers/assignmentController.js";

import firebaseAuth from "../middlewares/firebaseAuth.js";
import attachUser from "../middlewares/attachUser.js";
import roleGuard from "../middlewares/roleGuard.js";

const router = express.Router();


router.post(
  "/assign",
  firebaseAuth,
  attachUser,
  roleGuard("admin"),
  assignCourseToStudent
);


router.post(
  "/unassign",
  firebaseAuth,
  attachUser,
  roleGuard("admin"),
  unassignCourse
);

router.post(
  "/assign-group",
  firebaseAuth,
  attachUser,
  roleGuard("admin"),
  assignCourseToGroup
);

router.get(
  "/my-courses",
  firebaseAuth,
  attachUser,
  roleGuard("student","user"),
  getMyCourses
);

router.get(
  "/approved",
  firebaseAuth,
  attachUser,
  roleGuard("student","user"),
  getPublishedCourses
);

router.post(
  "/enroll",
  firebaseAuth,
  attachUser,
  roleGuard("student"),
  enrollCourse
);

router.get(
  "/instructor/students/count",
  firebaseAuth,
  attachUser,
  roleGuard("instructor"),
  getInstructorStudentCount
);

router.get(
  "/instructor/students",
  firebaseAuth,
  attachUser,
  roleGuard("instructor"),
  getInstructorEnrolledStudents
);


export default router;

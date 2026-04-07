import express from "express";
import {
	createGroup,
	getGroups,
	getGroup,
	getGroupUsers,
	addUserToGroup,
	removeUserFromGroup,
	updateGroup,
	deleteGroup,
	getInstructorGroups,
	getInstructorGroup,
	getStudentGroups,
	getStudentGroup,
} from "../controllers/group.controller.js";
import firebaseAuth from "../middlewares/firebaseAuth.js";
import attachUser from "../middlewares/attachUser.js";
import roleGuard from "../middlewares/roleGuard.js";

const router = express.Router();

// All admin-protected
router.post("/", firebaseAuth, attachUser, roleGuard("admin"), createGroup);
router.get("/", firebaseAuth, attachUser, roleGuard("admin"), getGroups);
router.get("/instructor/my-groups", firebaseAuth, attachUser, roleGuard("instructor", "company"), getInstructorGroups);
router.get("/instructor/:groupId", firebaseAuth, attachUser, roleGuard("instructor", "company"), getInstructorGroup);
router.get("/my-groups", firebaseAuth, attachUser, getStudentGroups); // Student see their groups
router.get("/my-groups/:groupId", firebaseAuth, attachUser, getStudentGroup); // Student see single group details
router.get("/:groupId", firebaseAuth, attachUser, roleGuard("admin"), getGroup);
router.put("/:groupId", firebaseAuth, attachUser, roleGuard("admin"), updateGroup);
router.delete("/:groupId", firebaseAuth, attachUser, roleGuard("admin"), deleteGroup);
router.get("/:groupId/users", firebaseAuth, attachUser, roleGuard("admin"), getGroupUsers);
router.post("/:groupId/users/:userId", firebaseAuth, attachUser, roleGuard("admin"), addUserToGroup);
router.delete("/:groupId/users/:userId", firebaseAuth, attachUser, roleGuard("admin"), removeUserFromGroup);

export default router;
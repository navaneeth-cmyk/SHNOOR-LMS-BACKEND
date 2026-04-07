// routes/group.routes.js
import express from 'express';
import firebaseAuth from '../middlewares/firebaseAuth.js';
import attachUser from "../middlewares/attachUser.js";
import roleGuard from "../middlewares/roleGuard.js";
import {
  createGroup,
  getMyGroups,
  getStudentGroups,
  addMemberToGroup,
  removeMemberFromGroup,
  promoteToLeader,
  sendGroupMessage,
  getGroupMessages,
  getAdminGroupMembers,
  getGroupById,
  getAllGroups,
  createGroupByCollege,
  getStudentsByCollege,
  getColleges,
  deleteGroup
} from '../controllers/admingroup.controller.js';

const router = express.Router();
router.use((req, res, next) => {
  console.log('[group.routes] Middleware running for:', req.method, req.path);
  next();
});
// Admin-only routes
router.post('/', firebaseAuth,attachUser,roleGuard("admin"), createGroup);
router.delete('/:groupId', firebaseAuth,attachUser,roleGuard("admin"), deleteGroup);
router.get('/admin/my-groups', firebaseAuth,attachUser,roleGuard("admin"), getMyGroups);
router.post('/:groupId/members', firebaseAuth,attachUser,roleGuard("admin"), addMemberToGroup);
router.delete('/:groupId/members/:userId', firebaseAuth,attachUser,roleGuard("admin"), removeMemberFromGroup);
router.put('/:groupId/members/:userId/role', firebaseAuth,attachUser,roleGuard("admin"), promoteToLeader);

// Student + Admin routes
router.get('/', firebaseAuth, getAllGroups);  // for admin to see all groups
router.get('/my-groups',firebaseAuth, getStudentGroups);
router.get('/colleges', firebaseAuth, getColleges); // New route to get unique colleges
router.get('/students-by-college', firebaseAuth, getStudentsByCollege);
// Group messaging routes
router.get('/:groupId', firebaseAuth, getGroupById);
router.get('/:groupId/messages', firebaseAuth, getGroupMessages);
router.get('/:groupId/members', firebaseAuth, getAdminGroupMembers);

router.post('/:groupId/messages', firebaseAuth, sendGroupMessage);

router.post('/by-college', firebaseAuth, createGroupByCollege);

// Export the router (named export - matches how we import it in app.js)
export { router };

// Alternative (if you prefer default export):
// export default router;
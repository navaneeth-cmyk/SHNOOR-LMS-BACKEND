// controllers/group.controller.js – ES module version
import pool from '../db/postgres.js';

// 1. Create new group (only admin)
export const createGroup = async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    const firebaseUid = req.firebase?.uid;
    if (!firebaseUid) return res.status(401).json({ message: 'Unauthorized' });

    const { name, description, studentIds = [], instructorIds = [] } = req.body;

    if (!name?.trim()) return res.status(400).json({ message: 'Group name required' });

    // Get admin's internal user_id
    const adminRes = await client.query(
      'SELECT user_id FROM users WHERE firebase_uid = $1 AND role = $2',
      [firebaseUid, 'admin']
    );

    if (adminRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'Admin access only' });
    }

    const adminId = adminRes.rows[0].user_id;

    // Create group
    const groupRes = await client.query(
      'INSERT INTO admin_groups (admin_id, name, description, created_at) VALUES ($1, $2, $3, NOW()) RETURNING group_id',
      [adminId, name.trim(), description?.trim() || null]
    );

    const groupId = groupRes.rows[0].group_id;

    // Add members (students + instructors)
    let memberCount = 0;
    const requestedMemberIds = Array.from(
      new Set([...(Array.isArray(studentIds) ? studentIds : []), ...(Array.isArray(instructorIds) ? instructorIds : [])])
    );

    if (requestedMemberIds.length > 0) {
      const validMembersRes = await client.query(
        `SELECT user_id
         FROM users
         WHERE user_id = ANY($1::uuid[])
           AND status = 'active'
           AND role IN ('student', 'instructor')`,
        [requestedMemberIds]
      );

      const validMemberIds = validMembersRes.rows.map((row) => row.user_id);
      if (validMemberIds.length > 0) {
        await client.query(
          `INSERT INTO admin_group_members (group_id, user_id, role_in_group)
           SELECT $1, member_id, 'member'
           FROM UNNEST($2::uuid[]) AS member_id
           ON CONFLICT (group_id, user_id) DO NOTHING`,
          [groupId, validMemberIds]
        );
      }

      memberCount = validMemberIds.length;
    }

    await client.query('COMMIT');

    res.status(201).json({ 
      group_id: groupId,
      name,
      member_count: memberCount
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('createGroup error:', err);
    res.status(500).json({ message: 'Failed to create group' });
  } finally {
    client.release();
  }
};

// 2. Admin sees his created groups
export const getMyGroups = async (req, res) => {
  try {
    const adminId = req.user?.uid || req.user?.id;
    if (!adminId) return res.status(401).json({ message: 'Unauthorized' });

    const result = await pool.query(
      'SELECT * FROM admin_groups WHERE admin_id = $1 ORDER BY created_at DESC',
      [adminId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch groups' });
  }
};

// 3. Student sees groups he is member of
export const getStudentGroups = async (req, res) => {
  try {
    const firebaseUid = req.firebase?.uid;

    if (!firebaseUid) {
      console.log('[getStudentGroups] No firebase UID in request');
      return res.status(401).json({ message: 'Unauthorized - authentication required' });
    }

    console.log(`[getStudentGroups] Firebase UID received: ${firebaseUid}`);

    // Step 1: Lookup internal user_id from firebase_uid
    const userLookup = await pool.query(
      `SELECT user_id 
       FROM users 
       WHERE firebase_uid = $1`,
      [firebaseUid]
    );

    if (userLookup.rows.length === 0) {
      console.log(`[getStudentGroups] No user found for firebase_uid: ${firebaseUid}`);
      return res.status(404).json({ 
        message: 'User not found in database. Please contact support.' 
      });
    }

    const internalUserId = userLookup.rows[0].user_id;
    console.log(`[getStudentGroups] Mapped to internal user_id: ${internalUserId}`);

    // Step 2: Fetch groups using the correct internal UUID
    const groupsQuery = await pool.query(
      `SELECT 
         g.group_id,
         g.name,
         g.description,
         g.purpose,
         g.created_at,
         g.admin_id,
         COUNT(gm_all.user_id) AS member_count
       FROM admin_groups g
       JOIN admin_group_members gm_user
         ON g.group_id = gm_user.group_id AND gm_user.user_id = $1
       LEFT JOIN admin_group_members gm_all
         ON g.group_id = gm_all.group_id
       GROUP BY g.group_id
       ORDER BY g.created_at DESC`,
      [internalUserId]
    );

    console.log(`[getStudentGroups] Query successful - found ${groupsQuery.rows.length} groups`);

    return res.status(200).json(groupsQuery.rows);

  } catch (err) {
    console.error('[getStudentGroups] CRITICAL ERROR:', {
      message: err.message,
      code: err.code,
      detail: err.detail || 'no detail',
      hint: err.hint || 'no hint',
      queryParams: err.parameters || 'not available',
      stack: err.stack?.substring(0, 300) + '...' || 'no stack'
    });

    return res.status(500).json({ 
      message: 'Failed to load your groups',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined,
      code: err.code
    });
  }
};

// 4. Add member to group (admin or leader)
export const addMemberToGroup = async (req, res) => {
  try {
    const userId = req.user?.uid || req.user?.id;
    const { groupId } = req.params;
    const { studentId } = req.body;

    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    // Permission check
    const perm = await pool.query(
      `SELECT role_in_group 
       FROM admin_group_members 
       WHERE group_id = $1 AND user_id = $2`,
      [groupId, userId]
    );

    const isAdmin = await pool.query('SELECT role FROM users WHERE user_id = $1', [userId]);
    const canAdd = isAdmin.rows[0]?.role === 'admin' || 
                   perm.rows[0]?.role_in_group === 'leader' ||
                   perm.rows[0]?.role_in_group === 'moderator';

    if (!canAdd) return res.status(403).json({ message: 'Not authorized' });

    await pool.query(
      'INSERT INTO admin_group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [groupId, studentId]
    );

    res.status(201).json({ message: 'Student added to group' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to add member' });
  }
};

// Add similar ES module exports for the remaining functions
export const removeMemberFromGroup = async (req, res) => {
  try {
    const { groupId, userId } = req.params; // userId = student to remove

    await pool.query(
      'DELETE FROM admin_group_members WHERE group_id = $1 AND user_id = $2',
      [groupId, userId]
    );

    res.json({ message: 'Student removed from group' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to remove member' });
  }
};

export const getAllGroups = async (req, res) => {
  try {
    const userId = req.firebase?.uid;
    if (!userId) return res.status(401).json({ message: 'Unauthorized' });

    // Optional: only admins can see all groups
    const roleCheck = await pool.query(
      'SELECT role FROM users WHERE firebase_uid = $1',
      [userId]
    );

    if (roleCheck.rows[0]?.role !== 'admin') {
      return res.status(403).json({ message: 'Admin access required' });
    }

    const result = await pool.query(
      `SELECT 
         g.group_id,
         g.name,
         g.description,
         g.purpose,
         g.created_at,
         g.admin_id,
         u.full_name AS admin_name,
         (SELECT COUNT(*) FROM admin_group_members gm WHERE gm.group_id = g.group_id) AS member_count
       FROM admin_groups g
       LEFT JOIN users u ON g.admin_id = u.user_id
       ORDER BY g.created_at DESC`
    );

    console.log(`[getAllGroups] Admin loaded ${result.rows.length} groups`);

    res.json(result.rows);
  } catch (err) {
    console.error('[getAllGroups] Error:', err.message);
    res.status(500).json({ message: 'Failed to load groups' });
  }
};

export const promoteToLeader = async (req, res) => {
  try {
    const adminId = req.user?.uid || req.user?.id;
    const { groupId, userId } = req.params;
    const { role } = req.body; // 'leader' or 'moderator'

    if (!adminId) return res.status(401).json({ message: 'Unauthorized' });

    // Only admin of the group can promote
    const group = await pool.query('SELECT admin_id FROM admin_groups WHERE group_id = $1', [groupId]);
    if (group.rows[0]?.admin_id !== adminId) {
      return res.status(403).json({ message: 'Only group admin can promote' });
    }

    await pool.query(
      'UPDATE admin_group_members SET role_in_group = $1 WHERE group_id = $2 AND user_id = $3',
      [role, groupId, userId]
    );

    res.json({ message: `User promoted to ${role}` });
  } catch (err) {
    res.status(500).json({ message: 'Failed to promote member' });
  }
};

export const sendGroupMessage = async (req, res) => {
  try {
    const senderId = req.user?.uid || req.user?.id;
    const { groupId } = req.params;
    const { text, attachment_file_id, attachment_type, attachment_name } = req.body;

    if (!senderId) return res.status(401).json({ message: 'Unauthorized' });

    // Check membership
    const member = await pool.query(
      'SELECT 1 FROM admin_group_members WHERE group_id = $1 AND user_id = $2',
      [groupId, senderId]
    );
    if (member.rows.length === 0) return res.status(403).json({ message: 'Not a member' });

    const result = await pool.query(
      `INSERT INTO admin_group_messages 
       (group_id, sender_id, text, attachment_file_id, attachment_type, attachment_name)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [groupId, senderId, text || null, attachment_file_id || null, attachment_type || null, attachment_name || null]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ message: 'Failed to send group message' });
  }
};

export const getGroupById = async (req, res) => {
  try {
    const { groupId } = req.params;
    const firebaseUid = req.firebase?.uid;

    if (!firebaseUid) {
      return res.status(401).json({ message: 'Unauthorized - authentication required' });
    }

    console.log(`[getGroupById] User ${firebaseUid} requested group ${groupId}`);

    // Step 1: Map Firebase UID → internal user_id (UUID)
    const userLookup = await pool.query(
      'SELECT user_id FROM users WHERE firebase_uid = $1',
      [firebaseUid]
    );

    if (userLookup.rows.length === 0) {
      console.log(`[getGroupById] No user found for firebase_uid: ${firebaseUid}`);
      return res.status(404).json({ message: 'User not found' });
    }

    const userId = userLookup.rows[0].user_id;

    // Step 2: Fetch group
    const groupQuery = await pool.query(
      `SELECT 
         group_id,
         name,
         description,
         purpose,
         created_at,
         admin_id,
         (SELECT COUNT(*) FROM admin_group_members WHERE group_id = $1) AS member_count
       FROM admin_groups
       WHERE group_id = $1`,
      [groupId]
    );

    if (groupQuery.rows.length === 0) {
      return res.status(404).json({ message: 'Group not found' });
    }

    const group = groupQuery.rows[0];

    // Step 3: Permission check – allow members OR group admin
    const membershipCheck = await pool.query(
      'SELECT 1 FROM admin_group_members WHERE group_id = $1 AND user_id = $2',
      [groupId, userId]
    );

    const isGroupAdmin = group.admin_id === userId;

    if (membershipCheck.rows.length === 0 && !isGroupAdmin) {
      console.log(`[getGroupById] Access denied: ${userId} not member and not admin of ${groupId}`);
      return res.status(403).json({ message: 'You are not a member of this group' });
    }

    console.log(`[getGroupById] Access granted - ${isGroupAdmin ? 'admin' : 'member'}`);

    return res.json(group);

  } catch (err) {
    console.error('[getGroupById] CRITICAL ERROR:', {
      message: err.message,
      code: err.code,
      detail: err.detail || 'no detail',
      queryParams: err.parameters || 'unknown',
      stack: err.stack?.substring(0, 300) + '...'
    });

    return res.status(500).json({ 
      message: 'Failed to load group details',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
};

export const getGroupMessages = async (req, res) => {
  try {
    const { groupId } = req.params;
    const firebaseUid = req.firebase?.uid;

    if (!firebaseUid) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    console.log(`[getGroupMessages] User ${firebaseUid} requested messages for group ${groupId}`);

    // Step 1: Map Firebase UID → internal user_id (UUID)
    const userLookup = await pool.query(
      'SELECT user_id FROM users WHERE firebase_uid = $1',
      [firebaseUid]
    );

    if (userLookup.rows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }

    const userId = userLookup.rows[0].user_id;

    // Step 2: Fetch group info to check admin_id
    const groupQuery = await pool.query(
      'SELECT admin_id FROM admin_groups WHERE group_id = $1',
      [groupId]
    );

    if (groupQuery.rows.length === 0) {
      return res.status(404).json({ message: 'Group not found' });
    }

    const isGroupAdmin = groupQuery.rows[0].admin_id === userId;

    // Step 3: Check membership (skip if admin)
    let isMember = isGroupAdmin;

    if (!isGroupAdmin) {
      const membership = await pool.query(
        'SELECT 1 FROM admin_group_members WHERE group_id = $1 AND user_id = $2',
        [groupId, userId]
      );
      isMember = membership.rows.length > 0;
    }

    if (!isMember) {
      console.log(`[getGroupMessages] Access denied: ${userId} is neither member nor admin`);
      return res.status(403).json({ message: 'You are not a member of this group' });
    }

    // Step 4: Fetch messages
    const messagesQuery = await pool.query(
      `SELECT 
         m.message_id,
         m.group_id,
         m.sender_id,
         m.text,
         m.created_at,
         m.attachment_file_id,
         m.attachment_type,
         m.attachment_name,
         u.full_name AS sender_name,
         u.role AS sender_role
       FROM admin_group_messages m
       JOIN users u ON m.sender_id = u.user_id
       WHERE m.group_id = $1
       ORDER BY m.created_at ASC`,
      [groupId]
    );

    console.log(`[getGroupMessages] Success - found ${messagesQuery.rows.length} messages`);

    return res.json(messagesQuery.rows);

  } catch (err) {
    console.error('[getGroupMessages] CRITICAL ERROR:', {
      message: err.message,
      code: err.code,
      detail: err.detail || 'no detail',
      hint: err.hint || 'no hint',
      params: err.parameters || 'unknown',
      stack: err.stack?.substring(0, 300) + '...'
    });

    return res.status(500).json({ 
      message: 'Failed to load group messages',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
};

export const getColleges = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT 
         COALESCE(NULLIF(u.college, ''), NULLIF(u.college_name, '')) AS college_id,
         COALESCE(NULLIF(u.college, ''), NULLIF(u.college_name, '')) AS name,
         COUNT(*) AS student_count
       FROM users u
       WHERE u.role = 'student'
         AND COALESCE(NULLIF(u.college, ''), NULLIF(u.college_name, '')) IS NOT NULL
       GROUP BY COALESCE(NULLIF(u.college, ''), NULLIF(u.college_name, ''))
       ORDER BY COALESCE(NULLIF(u.college, ''), NULLIF(u.college_name, '')) ASC`
    );

    res.json(result.rows);
  } catch (err) {
    console.error('[getColleges] Error:', err.message);
    res.status(500).json({ message: 'Failed to load colleges' });
  }
};

export const createGroupByCollege = async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const adminUid = req.firebase?.uid;
    if (!adminUid) return res.status(401).json({ message: 'Unauthorized' });

    const { name, description, college_id, college_name, college, instructorIds = [] } = req.body;
    const collegeValue = (college || college_name || college_id || '').trim();

    if (!name?.trim() || !collegeValue) {
      return res.status(400).json({ message: 'Group name and college required' });
    }

    // Get admin internal ID
    const adminRes = await client.query(
      'SELECT user_id FROM users WHERE firebase_uid = $1 AND role = $2',
      [adminUid, 'admin']
    );

    if (adminRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'Admin access only' });
    }

    const adminId = adminRes.rows[0].user_id;

    // Create group
    const groupRes = await client.query(
      `INSERT INTO admin_groups (admin_id, name, description, created_at)
       VALUES ($1, $2, $3, NOW()) RETURNING group_id`,
      [adminId, name.trim(), description?.trim() || null]
    );

    const groupId = groupRes.rows[0].group_id;

    // Get students from this college
    const studentsRes = await client.query(
      `SELECT user_id
       FROM users
       WHERE role = 'student'
         AND COALESCE(NULLIF(college, ''), NULLIF(college_name, '')) = $1`,
      [collegeValue]
    );

    const studentIds = studentsRes.rows.map(r => r.user_id);

    let validInstructorIds = [];
    if (Array.isArray(instructorIds) && instructorIds.length > 0) {
      const instructorRes = await client.query(
        `SELECT user_id
         FROM users
         WHERE user_id = ANY($1::uuid[])
           AND status = 'active'
           AND role = 'instructor'`,
        [instructorIds]
      );
      validInstructorIds = instructorRes.rows.map((row) => row.user_id);
    }

    const memberIds = Array.from(new Set([...studentIds, ...validInstructorIds]));

    if (memberIds.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'No members found for this group' });
    }

    await client.query(
      `INSERT INTO admin_group_members (group_id, user_id, role_in_group)
       SELECT $1, member_id, 'member'
       FROM UNNEST($2::uuid[]) AS member_id
       ON CONFLICT (group_id, user_id) DO NOTHING`,
      [groupId, memberIds]
    );

    await client.query('COMMIT');

    res.status(201).json({
      group_id: groupId,
      name,
      college_id: collegeValue,
      college_name: collegeValue,
      member_count: memberIds.length
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[createGroupByCollege] Error:', err.message);
    res.status(500).json({ message: 'Failed to create group' });
  } finally {
    client.release();
  }
};

export const getStudentsByCollege = async (req, res) => {
  try {
    const { college } = req.query; // ?college=Delhi%20University

    let query = `
      SELECT user_id, full_name, email, college_name
      FROM users
      WHERE role = 'student'
      ORDER BY full_name ASC
    `;
    let params = [];

    if (college) {
      query = `
        SELECT user_id, full_name, email, college_name
        FROM users
        WHERE role = 'student'
          AND COALESCE(NULLIF(college, ''), NULLIF(college_name, '')) = $1
        ORDER BY full_name ASC
      `;
      params = [college];
    }

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('[getStudentsByCollege] Error:', err);
    res.status(500).json({ message: 'Failed to load students' });
  }
};

export const getAdminGroupMembers = async (req, res) => {
  try {
    const { groupId } = req.params;
    const firebaseUid = req.firebase?.uid;

    if (!firebaseUid) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const userLookup = await pool.query(
      "SELECT user_id FROM users WHERE firebase_uid = $1",
      [firebaseUid],
    );

    if (userLookup.rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    const userId = userLookup.rows[0].user_id;

    const groupQuery = await pool.query(
      "SELECT admin_id FROM admin_groups WHERE group_id = $1",
      [groupId],
    );

    if (groupQuery.rows.length === 0) {
      return res.status(404).json({ message: "Group not found" });
    }

    const isGroupAdmin = groupQuery.rows[0].admin_id === userId;

    if (!isGroupAdmin) {
      const membership = await pool.query(
        "SELECT 1 FROM admin_group_members WHERE group_id = $1 AND user_id = $2",
        [groupId, userId],
      );
      if (membership.rows.length === 0) {
        return res.status(403).json({ message: "You are not a member of this group" });
      }
    }

    const membersQuery = await pool.query(
      `SELECT
         u.user_id AS id,
         u.full_name AS name,
         u.role AS global_role,
         gm.role_in_group AS group_role,
         u.photo_url,
         u.email
       FROM admin_group_members gm
       JOIN users u ON gm.user_id = u.user_id
       WHERE gm.group_id = $1
       ORDER BY u.full_name ASC`,
      [groupId],
    );

    return res.status(200).json(membersQuery.rows);
  } catch (err) {
    console.error("getAdminGroupMembers error:", error);
    return res.status(500).json({ message: "Failed to load group members" });
  }
};

export const deleteGroup = async (req, res) => {
  try {
    const { groupId } = req.params;
    const adminUid = req.firebase?.uid;

    if (!adminUid) return res.status(401).json({ message: 'Unauthorized' });

    // Verify admin
    const adminRes = await pool.query(
      'SELECT user_id, role FROM users WHERE firebase_uid = $1',
      [adminUid]
    );

    if (adminRes.rows.length === 0 || adminRes.rows[0].role !== 'admin') {
      return res.status(403).json({ message: 'Admin access only' });
    }

    const adminId = adminRes.rows[0].user_id;

    // Check if the group exists and belongs to this admin (or just allow any admin to delete others' groups? Usually Admin role is enough)
    // We'll allow any admin to delete any group for now, but we can restrict to owner if needed.
    const groupCheck = await pool.query(
      'SELECT admin_id FROM admin_groups WHERE group_id = $1',
      [groupId]
    );

    if (groupCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Group not found' });
    }

    // Delete members and messages first if CASCADE is not set, but standard is CASCADE on group_id
    // We'll perform explicit deletes for safety
    await pool.query('DELETE FROM admin_group_members WHERE group_id = $1', [groupId]);
    await pool.query('DELETE FROM admin_group_messages WHERE group_id = $1', [groupId]);
    await pool.query('DELETE FROM admin_groups WHERE group_id = $1', [groupId]);

    res.json({ message: 'Group deleted successfully' });
  } catch (err) {
    console.error('deleteGroup error:', err);
    res.status(500).json({ message: 'Failed to delete group' });
  }
};
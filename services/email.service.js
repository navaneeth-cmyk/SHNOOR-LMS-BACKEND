import { sendMail } from "../config/mailer.js";
import admin from "./firebaseAdmin.js";

const defaultFrontendUrl = (process.env.FRONTEND_URL || "https://lms.shnoor.com").replace(/\/$/, "");

// Generate Firebase password reset link
export const generatePasswordResetLink = async (email) => {
  try {
    const link = await admin.auth().generatePasswordResetLink(email);
    // Convert to frontend create-password route with oobCode
    const createPasswordUrl = `${defaultFrontendUrl}/create-password?oobCode=${link.split("oobCode=")[1]}&email=${encodeURIComponent(email)}`;
    return createPasswordUrl;
  } catch (error) {
    console.error(`Failed to generate password reset link for ${email}:`, error);
    return null;
  }
};

const normalizeInviteInput = (emailOrObj, name) => {
  if (typeof emailOrObj === "object" && emailOrObj !== null) {
    return {
      email: emailOrObj.email,
      displayName: emailOrObj.name || emailOrObj.displayName,
      createPasswordUrl: emailOrObj.createPasswordUrl || null,
      loginUrl: emailOrObj.loginUrl || `${defaultFrontendUrl}/login`,
      hasPredefinedPassword: Boolean(emailOrObj.hasPredefinedPassword),
      temporaryPassword: emailOrObj.temporaryPassword || null,
    };
  }

  return {
    email: emailOrObj,
    displayName: name,
    createPasswordUrl: null,
    loginUrl: `${defaultFrontendUrl}/login`,
    hasPredefinedPassword: false,
    temporaryPassword: null,
  };
};

const buildInviteHtml = ({ displayName, roleLabel, createPasswordUrl, loginUrl, hasPredefinedPassword, temporaryPassword }) => {
  const linkSection = createPasswordUrl
    ? `
        <p>Set your password before signing in.</p>
        <p>
          <a href="${createPasswordUrl}" style="display:inline-block;padding:12px 18px;background:#4f46e5;color:#ffffff;text-decoration:none;border-radius:10px;font-weight:700;">
            Create Password
          </a>
        </p>
      `
    : `<p>Use the link below to sign in to your dashboard.</p>`;

  const passwordSection = hasPredefinedPassword && temporaryPassword
    ? `<p><b>Temporary Password:</b> ${temporaryPassword}</p>`
    : "";

  return `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#0f172a;max-width:600px;">
      <h2 style="margin-bottom:8px;">Welcome to SHNOOR LMS</h2>
      <p>Hello <b>${displayName || ""}</b>,</p>
      <p>You have been added as a ${roleLabel}.</p>
      ${passwordSection}
      ${linkSection}
      <p>
        <a href="${loginUrl}" style="display:inline-block;padding:12px 18px;background:#0f172a;color:#ffffff;text-decoration:none;border-radius:10px;font-weight:700;">
          Login to Dashboard
        </a>
      </p>
      <p style="color:#475569;font-size:14px;">If you did not expect this invite, please contact the SHNOOR LMS administrator.</p>
    </div>
  `;
};

const sendInvite = async (emailOrObj, name, roleLabel, subject) => {
  const invite = normalizeInviteInput(emailOrObj, name);

  if (!invite.email) {
    console.error(`send${roleLabel}Invite: missing email`);
    return;
  }

  try {
    return await sendMail({
      to: invite.email,
      subject,
      html: buildInviteHtml({
        displayName: invite.displayName,
        roleLabel,
        createPasswordUrl: invite.createPasswordUrl,
        loginUrl: invite.loginUrl,
        hasPredefinedPassword: invite.hasPredefinedPassword,
        temporaryPassword: invite.temporaryPassword,
      }),
    });
  } catch (error) {
    console.error(`Failed to send ${roleLabel.toLowerCase()} invite:`, error);
    throw error;
  }
};

export const sendInstructorInvite = async (emailOrObj, name) =>
  sendInvite(emailOrObj, name, "Instructor", "You have been invited as an Instructor");

export const sendStudentInvite = async (emailOrObj, name) =>
  sendInvite(emailOrObj, name, "Student", "You have been invited as a Student");

export const sendManagerInvite = async (emailOrObj, name) =>
  sendInvite(emailOrObj, name, "Manager", "You have been invited as a Manager");

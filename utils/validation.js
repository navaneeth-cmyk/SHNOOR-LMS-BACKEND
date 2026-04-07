/**
 * Validation utility for instructor data
 * Used for both single and bulk instructor creation
 */

export const validateEmail = (email) => {
  if (!email || typeof email !== 'string') {
    return { valid: false, error: 'Email is required' };
  }

  const trimmed = email.trim();
  
  // Basic email regex
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  
  if (!emailRegex.test(trimmed)) {
    return { valid: false, error: 'Invalid email format' };
  }

  if (trimmed.length > 255) {
    return { valid: false, error: 'Email too long (max 255 characters)' };
  }

  return { valid: true, value: trimmed.toLowerCase() };
};

export const validateFullName = (fullName) => {
  if (!fullName || typeof fullName !== 'string') {
    return { valid: false, error: 'Full name is required' };
  }

  const trimmed = fullName.trim();

  if (trimmed.length < 2) {
    return { valid: false, error: 'Full name must be at least 2 characters' };
  }

  if (trimmed.length > 100) {
    return { valid: false, error: 'Full name too long (max 100 characters)' };
  }

  // Allow letters, spaces, hyphens, apostrophes, and common international characters
  const nameRegex = /^[a-zA-ZÀ-ÿ\s'-]+$/;
  
  if (!nameRegex.test(trimmed)) {
    return { valid: false, error: 'Full name contains invalid characters' };
  }

  return { valid: true, value: trimmed };
};

export const validateSubject = (subject) => {
  if (!subject || typeof subject !== 'string') {
    return { valid: false, error: 'Subject is required' };
  }

  const trimmed = subject.trim();

  if (trimmed.length < 2) {
    return { valid: false, error: 'Subject must be at least 2 characters' };
  }

  if (trimmed.length > 200) {
    return { valid: false, error: 'Subject too long (max 200 characters)' };
  }

  return { valid: true, value: trimmed };
};

export const validatePhone = (phone) => {
  // Phone is optional
  if (!phone || phone.trim() === '') {
    return { valid: true, value: null };
  }

  const trimmed = phone.trim();

  // Loose phone validation: allows +, digits, spaces, hyphens, parentheses
  const phoneRegex = /^\+?[\d\s()-]{7,20}$/;
  
  if (!phoneRegex.test(trimmed)) {
    return { valid: false, error: 'Invalid phone format' };
  }

  return { valid: true, value: trimmed };
};

export const validateBio = (bio) => {
  // Bio is optional
  if (!bio || bio.trim() === '') {
    return { valid: true, value: null };
  }

  const trimmed = bio.trim();

  if (trimmed.length > 1000) {
    return { valid: false, error: 'Bio too long (max 1000 characters)' };
  }

  return { valid: true, value: trimmed };
};

/**
 * Validates complete instructor data
 * @param {Object} data - Instructor data
 * @returns {Object} { valid: boolean, errors: Object, data: Object }
 */
export const validateInstructorData = (data) => {
  const errors = {};
  const validatedData = {};

  // Validate email
  const emailResult = validateEmail(data.email);
  if (!emailResult.valid) {
    errors.email = emailResult.error;
  } else {
    validatedData.email = emailResult.value;
  }

  // Validate fullName
  const nameResult = validateFullName(data.fullName);
  if (!nameResult.valid) {
    errors.fullName = nameResult.error;
  } else {
    validatedData.fullName = nameResult.value;
  }

  // Validate subject
  const subjectResult = validateSubject(data.subject);
  if (!subjectResult.valid) {
    errors.subject = subjectResult.error;
  } else {
    validatedData.subject = subjectResult.value;
  }

  // Validate phone (optional)
  const phoneResult = validatePhone(data.phone);
  if (!phoneResult.valid) {
    errors.phone = phoneResult.error;
  } else {
    validatedData.phone = phoneResult.value;
  }

  // Validate bio (optional)
  const bioResult = validateBio(data.bio);
  if (!bioResult.valid) {
    errors.bio = bioResult.error;
  } else {
    validatedData.bio = bioResult.value;
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
    data: validatedData
  };
};
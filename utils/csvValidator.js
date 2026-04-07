/**
 * CSV Validator for Bulk Instructor Upload
 * Validates instructor data from CSV rows
 */

// RFC 5322 compliant email regex (simplified version)
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Name regex: letters, spaces, hyphens, apostrophes, periods (for titles like Dr., Jr., etc.)
const NAME_REGEX = /^[a-zA-Z\s'.-]+$/;

// Phone regex: flexible format (E.164 or common formats)
const PHONE_REGEX = /^\+?[\d\s()-]{7,20}$/;

export const validateInstructorData = (data, rowNumber) => {
  const errors = [];

  // 1. Required Fields Check
  if (!data.fullName || data.fullName.trim() === '') {
    errors.push({ row: rowNumber, message: 'fullName is required' });
  }

  if (!data.email || data.email.trim() === '') {
    errors.push({ row: rowNumber, message: 'email is required' });
  }

  if (!data.subject || data.subject.trim() === '') {
    errors.push({ row: rowNumber, message: 'subject is required' });
  }

  // 2. Full Name Validation
  if (data.fullName && data.fullName.trim() !== '') {
    const trimmedName = data.fullName.trim();
    if (trimmedName.length < 2) errors.push({ row: rowNumber, message: 'fullName must be at least 2 characters' });
    if (trimmedName.length > 100) errors.push({ row: rowNumber, message: 'fullName must not exceed 100 characters' });
    if (!NAME_REGEX.test(trimmedName)) errors.push({ row: rowNumber, message: 'fullName contains invalid characters' });
  }

  // 3. Email Validation
  if (data.email && data.email.trim() !== '') {
    const trimmedEmail = data.email.trim();
    if (!EMAIL_REGEX.test(trimmedEmail)) errors.push({ row: rowNumber, message: 'invalid email format' });
  }

  // 4. Subject Validation
  if (data.subject && data.subject.trim() !== '') {
    const trimmedSubject = data.subject.trim();
    if (trimmedSubject.length < 2) errors.push({ row: rowNumber, message: 'subject must be at least 2 characters' });
  }

  // 5. Phone & Bio (Minimal checks since they are optional)
  if (data.phone && data.phone.trim() !== '' && !PHONE_REGEX.test(data.phone.trim())) {
    errors.push({ row: rowNumber, message: 'invalid phone format' });
  }

  return {
    valid: errors.length === 0,
    errors
  };
};

/**
 * Normalize instructor data (trim, lowercase email, etc.)
 */
export const normalizeInstructorData = (data) => {
  return {
    fullName: data.fullName ? String(data.fullName).trim() : '',
    email: data.email ? String(data.email).trim().toLowerCase() : '',
    subject: data.subject ? String(data.subject).trim() : '',
    phone: data.phone ? String(data.phone).trim() : null,
    bio: data.bio ? String(data.bio).trim() : null,
  };
};

/**
 * Validate entire CSV data array
 */
export const validateBulkInstructors = (instructors) => {
  const allErrors = [];
  const validData = [];
  const emailsSeen = new Set();

  instructors.forEach((instructor, index) => {
    const rowNumber = index + 2;
    
    // Skip completely empty rows
    const hasData = Object.values(instructor).some(val => val && String(val).trim() !== '');
    if (!hasData) return;

    const normalized = normalizeInstructorData(instructor);
    const { valid, errors } = validateInstructorData(normalized, rowNumber);
    
    if (!valid) {
      allErrors.push(...errors);
    } else {
      if (emailsSeen.has(normalized.email)) {
        allErrors.push({ row: rowNumber, email: normalized.email, message: 'duplicate email in CSV' });
      } else {
        emailsSeen.add(normalized.email);
        validData.push({ ...normalized, rowNumber });
      }
    }
  });

  return {
    valid: allErrors.length === 0,
    errors: allErrors,
    validData
  };
};
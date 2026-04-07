import pool from "../../db/postgres.js";

/**
 * Auto-grade descriptive answer based on word count and keywords
 * Scoring:
 * - 40% for meeting minimum word count
 * - 60% for keyword matching
 */
export const autoGradeDescriptive = (answerText, keywords, minWordCount, maxMarks) => {
  if (!answerText || typeof answerText !== 'string') {
    return 0;
  }

  const answer = answerText.trim().toLowerCase();
  const words = answer.split(/\s+/).filter(w => w.length > 0);
  const wordCount = words.length;

  let score = 0;

  // 40% for word count
  if (wordCount >= minWordCount) {
    score += maxMarks * 0.4;
  } else if (wordCount > 0) {
    // Partial credit for some words
    score += maxMarks * 0.4 * (wordCount / minWordCount);
  }

  // 60% for keyword matching
  if (keywords && keywords.length > 0) {
    const keywordsArray = Array.isArray(keywords) ? keywords : JSON.parse(keywords || '[]');
    if (keywordsArray.length > 0) {
      let keywordsFound = 0;

      for (const keyword of keywordsArray) {
        const keywordLower = keyword.toLowerCase().trim();
        // Check if keyword is in answer (word boundary or phrase match)
        if (
          answer.includes(keywordLower) ||
          words.some(w => w.includes(keywordLower))
        ) {
          keywordsFound++;
        }
      }

      const keywordScore = (keywordsFound / keywordsArray.length) * maxMarks * 0.6;
      score += keywordScore;
    }
  } else {
    // No keywords specified, award partial 60% for having content
    if (wordCount > 0) {
      score += maxMarks * 0.6;
    }
  }

  return Math.round(score);
};

/**
 * Instructor adds DESCRIPTIVE question
 */
export const addDescriptiveQuestion = async (req, res) => {
  try {
    const { examId } = req.params;
    const { questionText, marks, order, keywords, minWordCount } = req.body;

    if (!questionText) {
      return res.status(400).json({
        message: "Question text is required",
      });
    }

    // Parse keywords (comma-separated string or array)
    let keywordsArray = [];
    if (keywords) {
      keywordsArray = Array.isArray(keywords)
        ? keywords
        : keywords.split(',').map(k => k.trim()).filter(k => k);
    }

    const { rows } = await pool.query(
      `
      INSERT INTO exam_questions
        (exam_id, question_text, marks, question_order, question_type, keywords, min_word_count)
      VALUES ($1, $2, $3, $4, 'descriptive', $5, $6)
      RETURNING question_id
      `,
      [
        examId,
        questionText,
        marks ?? 10,
        order ?? 1,
        JSON.stringify(keywordsArray),
        minWordCount ?? 30
      ]
    );

    res.status(201).json({
      message: "Descriptive question added successfully",
      questionId: rows[0].question_id,
      keywords: keywordsArray,
      minWordCount: minWordCount ?? 30
    });
  } catch (err) {
    console.error("Add descriptive question error:", err);
    res.status(500).json({
      message: "Failed to add descriptive question",
    });
  }
};

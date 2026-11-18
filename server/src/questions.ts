import type { PendingQuestion, Question } from "./contracts";

/** Longest written answer the app passes on to the agent. */
export const MAX_ANSWER = 2000;

/**
 * Codex asks the agent to mark its suggested option by appending
 * "(Recommended)" to the label; the screen shows that as a word of its own.
 */
export function optionLabel(label: string): { text: string; recommended: boolean } {
  const match = label.match(/^(.*?)\s*\((?:recommended|recomendad[ao])\)\s*$/i);
  return match && match[1] ? { text: match[1], recommended: true } : { text: label, recommended: false };
}

/**
 * What the agent receives for one question: the chosen label, or the written
 * text marked the way Codex's own client marks a free answer. Undefined when
 * the value is not a valid answer to that question.
 */
export function agentAnswer(question: Question, value: unknown): string[] | undefined {
  if (typeof value !== "string") return undefined;
  if (question.options.some((option) => option.label === value)) return [value];
  const written = value.trim();
  if (!question.other || !written || written.length > MAX_ANSWER) return undefined;
  return [`user_note: ${written}`];
}

/** The user's side of the conversation once she answered. */
export function answerRecord(question: PendingQuestion, answers: Record<string, string>) {
  return question.questions
    .map((q) => {
      const answer = q.secret ? "(respuesta privada)" : optionLabel(answers[q.id].trim()).text;
      return question.questions.length > 1 || q.header ? `${q.header || q.text}: ${answer}` : answer;
    })
    .join("\n");
}

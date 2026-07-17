import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import {
  validateThemePromotionCandidate,
  type ThemePromotionResult,
} from "./promotion";

function isInsideRoot(root: string, target: string): boolean {
  const path = relative(root, target);
  return path !== "" && !path.startsWith("..") && !isAbsolute(path);
}

export function validateThemePromotionFile(
  candidatePath: string,
  repositoryRoot = process.cwd(),
): ThemePromotionResult {
  const root = resolve(repositoryRoot);
  const absoluteCandidate = resolve(root, candidatePath);
  if (!isInsideRoot(root, absoluteCandidate) || !existsSync(absoluteCandidate) || !statSync(absoluteCandidate).isFile()) {
    return {
      ok: false,
      errors: [{
        code: "invalid-input",
        path: "$",
        message: "Candidate must be a file inside the repository.",
      }],
    };
  }

  let input: unknown;
  try {
    input = JSON.parse(readFileSync(absoluteCandidate, "utf8")) as unknown;
  } catch (error) {
    return {
      ok: false,
      errors: [{
        code: "invalid-input",
        path: "$",
        message: `Candidate is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      }],
    };
  }

  return validateThemePromotionCandidate(input, {
    evidenceExists: (path) => {
      const absoluteEvidence = resolve(root, path);
      return isInsideRoot(root, absoluteEvidence)
        && existsSync(absoluteEvidence)
        && statSync(absoluteEvidence).isFile();
    },
  });
}

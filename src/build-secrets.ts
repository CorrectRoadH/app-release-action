import { ActionError } from "./model.js";

export interface BuildSecret { id: string; value: string }

export function parseBuildSecrets(input: string): BuildSecret[] {
  const result: BuildSecret[] = [];
  const seen = new Set<string>();
  for (const line of input.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const separator = line.indexOf("=");
    const id = line.slice(0, separator).trim();
    const value = line.slice(separator + 1);
    if (separator < 1 || !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(id) || /[\0\r\n]/.test(value) || seen.has(id))
      throw new ActionError("invalid_input", "inputs", "Invalid build secrets");
    seen.add(id);
    if (value) result.push({ id, value });
  }
  return result;
}

// Secret bytes never appear in command arguments, files, or the release record.
export function buildSecretOptions(secrets: BuildSecret[], environment: NodeJS.ProcessEnv) {
  const args: string[] = [];
  const env = { ...environment };
  secrets.forEach(({ id, value }, index) => {
    const variable = `APP_RELEASE_BUILD_SECRET_${index}`;
    env[variable] = value;
    args.push("--secret", `id=${id},env=${variable}`);
  });
  return { args, env };
}

export function maskSecrets(text: string, secrets: Record<string, string>): string {
    let masked = text;
    for (const [key, value] of Object.entries(secrets)) {
        if (value.length >= 4) {
            masked = masked.replaceAll(value, `***${key}***`);
        }
    }
    return masked;
}

export function maskEventsJsonl(lines: string[], secrets: Record<string, string>): string[] {
    return lines.map((line) => maskSecrets(line, secrets));
}

export function stripEnvFromProcess(keys: string[]): void {
    for (const key of keys) {
        delete process.env[key];
    }
}

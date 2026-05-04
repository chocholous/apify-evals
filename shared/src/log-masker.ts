export function maskSecrets(text: string, secrets: Record<string, string>): string {
    let masked = text;
    // Sort by value length descending — longer secrets first to avoid partial matches
    const sorted = Object.entries(secrets).sort((a, b) => b[1].length - a[1].length);
    for (const [key, value] of sorted) {
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

/**
 * MySQL/InnoDB deadlock and lock-wait retry helper.
 * Prisma may surface 1213/1205 as P2034 or as a driver-adapter error message;
 * treat all of them as retryable and retry the whole transaction.
 */
const MAX_ATTEMPTS = 3;

export function isMysqlRetryableError(error: unknown): boolean {
  const record = error as { code?: string; message?: string; meta?: unknown };
  if (record?.code === "P2034") return true;
  const text = `${record?.code ?? ""} ${record?.message ?? ""} ${JSON.stringify(record?.meta ?? "")}`;
  return /1213|1205|deadlock|lock wait timeout|try restarting transaction/i.test(text);
}

function jitterMs(attempt: number): number {
  const base = 40 * 2 ** attempt;
  return base + Math.floor(Math.random() * base);
}

export async function withMysqlRetry<T>(
  operation: () => Promise<T>,
  options?: { attempts?: number; onRetry?: (error: unknown, attempt: number) => void },
): Promise<T> {
  const attempts = options?.attempts ?? MAX_ATTEMPTS;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isMysqlRetryableError(error) || attempt === attempts - 1) {
        throw error;
      }
      options?.onRetry?.(error, attempt + 1);
      await new Promise((resolve) => setTimeout(resolve, jitterMs(attempt)));
    }
  }
  throw lastError;
}

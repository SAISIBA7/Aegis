export enum CircuitState {
  CLOSED = "CLOSED",
  OPEN = "OPEN",
  HALF_OPEN = "HALF_OPEN",
}

export class CircuitBreakerOpenError extends Error {
  constructor(message: string = "Circuit breaker is OPEN. Fast failing request.") {
    super(message);
    this.name = "CircuitBreakerOpenError";
    Object.setPrototypeOf(this, CircuitBreakerOpenError.prototype);
  }
}

export class CircuitBreakerTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Request timed out after ${timeoutMs}ms.`);
    this.name = "CircuitBreakerTimeoutError";
    Object.setPrototypeOf(this, CircuitBreakerTimeoutError.prototype);
  }
}

export interface CircuitBreakerOptions {
  failureThreshold?: number; // Number of failures before tripping OPEN (default 3)
  resetTimeoutMs?: number;   // Cooldown period before transitioning to HALF_OPEN (default 30s)
  timeoutMs?: number;        // Individual request timeout (default 15s)
  maxRetries?: number;       // Number of attempts within a single execution before failing (default 2)
}

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount: number = 0;
  private lastFailureTime: number = 0;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 3;
    this.resetTimeoutMs = options.resetTimeoutMs ?? 30000;
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.maxRetries = options.maxRetries ?? 2;
  }

  public getState(): CircuitState {
    this.checkStateTransition();
    return this.state;
  }

  public getFailureCount(): number {
    return this.failureCount;
  }

  public reset(): void {
    this.state = CircuitState.CLOSED;
    this.failureCount = 0;
    this.lastFailureTime = 0;
  }

  /**
   * Executes the given async function with circuit breaker protection and bounded retries.
   */
  public async execute<T>(action: () => Promise<T>): Promise<T> {
    this.checkStateTransition();

    if (this.state === CircuitState.OPEN) {
      throw new CircuitBreakerOpenError(
        `NIM API Circuit Breaker is OPEN (${this.failureCount} consecutive failures). Fast failing to prevent cascading delay.`
      );
    }

    let lastError: any;
    let attempt = 0;

    while (attempt <= this.maxRetries) {
      attempt++;
      try {
        const result = await this.executeWithTimeout(action, this.timeoutMs);
        this.onSuccess();
        return result;
      } catch (err: any) {
        lastError = err;
        console.warn(
          `[CircuitBreaker] Attempt ${attempt}/${this.maxRetries + 1} failed: ${err.message}`
        );
        if (attempt <= this.maxRetries) {
          // Short exponential backoff between retries (300ms, 600ms...)
          await new Promise((r) => setTimeout(r, attempt * 300));
        }
      }
    }

    this.onFailure();
    throw lastError;
  }

  private async executeWithTimeout<T>(
    action: () => Promise<T>,
    timeoutMs: number
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new CircuitBreakerTimeoutError(timeoutMs));
      }, timeoutMs);

      action()
        .then((res) => {
          clearTimeout(timer);
          resolve(res);
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  private checkStateTransition(): void {
    if (this.state === CircuitState.OPEN) {
      const now = Date.now();
      if (now - this.lastFailureTime > this.resetTimeoutMs) {
        this.state = CircuitState.HALF_OPEN;
        console.log("[CircuitBreaker] State transitioned OPEN -> HALF_OPEN (cooldown elapsed).");
      }
    }
  }

  private onSuccess(): void {
    if (this.state === CircuitState.HALF_OPEN || this.failureCount > 0) {
      console.log("[CircuitBreaker] Request succeeded. Circuit CLOSED and failure count reset.");
    }
    this.failureCount = 0;
    this.state = CircuitState.CLOSED;
  }

  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.failureCount >= this.failureThreshold || this.state === CircuitState.HALF_OPEN) {
      this.state = CircuitState.OPEN;
      console.error(
        `[CircuitBreaker] Failure threshold reached (${this.failureCount}/${this.failureThreshold}). Circuit tripped to OPEN.`
      );
    }
  }
}

// Export default singleton circuit breaker instance for NVIDIA NIM API
// timeoutMs is generous (90s) because the NIM API can take 60-80s to
// generate a response for the 30B model. The circuit breaker still fails
// fast on hard errors (auth failures, 5xx, network errors) and trips OPEN
// after `failureThreshold` consecutive failures.
export const nimCircuitBreaker = new CircuitBreaker({
  failureThreshold: 3,
  resetTimeoutMs: 30000,
  timeoutMs: 90000,
  maxRetries: 2,
});

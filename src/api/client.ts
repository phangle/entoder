/**
 * Base API client with retry logic and error handling
 */

import pino from "pino";

export interface APIClientOptions {
  baseURL: string;
  timeout?: number;
  retries?: number;
  logger: pino.Logger; // Required - should be passed from centralized logger
}

export class APIError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public response?: Response
  ) {
    super(message);
    this.name = "APIError";
  }
}

export class APIClient {
  private baseURL: string;
  private timeout: number;
  private retries: number;
  private debug: boolean;
  private logger: pino.Logger;

  constructor(options: APIClientOptions) {
    this.baseURL = options.baseURL.replace(/\/$/, ""); // Remove trailing slash
    this.timeout = options.timeout ?? 30000; // 30 second default
    this.retries = options.retries ?? 3;
    this.logger = options.logger;
    this.debug = this.logger.level === "debug" || this.logger.level === "trace";
  }

  /**
   * Make an API request with automatic retries
   */
  async request<T = any>(
    method: string,
    path: string,
    options: {
      body?: any;
      headers?: Record<string, string>;
      query?: Record<string, string>;
      skipRetry?: boolean;
    } = {}
  ): Promise<T> {
    const url = this.buildURL(path, options.query);
    const headers = {
      "Content-Type": "application/json",
      ...options.headers,
    };

    const fetchOptions: RequestInit = {
      method,
      headers,
      ...(options.body && { body: JSON.stringify(options.body) }),
    };

    // Log request details (debug level)
    this.logger.debug({ method, url, hasBody: !!options.body }, "Starting API request");
    if (this.debug && options.body) {
      this.logger.debug({ body: options.body }, "Request body");
    }

    let lastError: Error | undefined;
    const maxAttempts = options.skipRetry ? 1 : this.retries;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await this.fetchWithTimeout(url, fetchOptions);

        this.logger.debug({
          method,
          url,
          status: response.status,
          attempt,
          maxAttempts
        }, "Received API response");

        // Handle specific HTTP status codes
        if (!response.ok) {
          // Try to parse error message from response
          let errorMessage = "";
          const contentType = response.headers.get("content-type");

          try {
            if (contentType?.includes("application/json")) {
              const errorData = await response.json();
              // Try common error field names
              errorMessage = errorData.message || errorData.error || errorData.msg || JSON.stringify(errorData);
            } else {
              errorMessage = await response.text();
            }
          } catch {
            // If parsing fails, use a generic message
            errorMessage = response.statusText || "Unknown error";
          }

          if (response.status === 401) {
            this.logger.error({ status: 401, errorMessage, url }, "Unauthorized request");
            throw new APIError(`Unauthorized: ${errorMessage}`, 401, response);
          }

          if (response.status === 429) {
            // Rate limited - wait and retry
            if (attempt < maxAttempts) {
              const retryAfter = parseInt(response.headers.get("Retry-After") ?? "5");
              this.logger.warn({
                retryAfter,
                attempt,
                maxAttempts,
                url
              }, "Rate limited, retrying after delay");
              await this.sleep(retryAfter * 1000);
              continue;
            }
            this.logger.error({ status: 429, errorMessage, url }, "Rate limit exceeded");
            throw new APIError(`Rate limited: ${errorMessage}`, 429, response);
          }

          if (response.status >= 500) {
            // Server error - retry
            if (attempt < maxAttempts) {
              const backoffMs = this.exponentialBackoff(attempt);
              this.logger.warn({
                status: response.status,
                attempt,
                maxAttempts,
                backoffMs,
                url
              }, "Server error, retrying with backoff");
              await this.sleep(backoffMs);
              continue;
            }
            this.logger.error({
              status: response.status,
              errorMessage,
              url
            }, "Server error after all retries");
            throw new APIError(`Server error (${response.status}): ${errorMessage}`, response.status, response);
          }

          // Client error - don't retry
          this.logger.error({
            status: response.status,
            errorMessage,
            url
          }, "Client error");
          throw new APIError(`API error (${response.status}): ${errorMessage}`, response.status, response);
        }

        // Parse response
        const contentType = response.headers.get("content-type");
        if (contentType?.includes("application/json")) {
          const json = await response.json();
          this.logger.debug({ url, contentType }, "Parsed JSON response");
          return json;
        }

        const text = await response.text();
        this.logger.debug({ url, contentType, textLength: text.length }, "Parsed text response");
        return text as unknown as T;
      } catch (error) {
        lastError = error as Error;

        // Don't retry on auth errors or client errors
        if (error instanceof APIError && error.statusCode && error.statusCode < 500) {
          throw error;
        }

        // Retry on network errors
        if (attempt < maxAttempts) {
          const backoffMs = this.exponentialBackoff(attempt);
          this.logger.warn({
            error: error instanceof Error ? error.message : String(error),
            attempt,
            maxAttempts,
            backoffMs,
            url
          }, "Network error, retrying with backoff");
          await this.sleep(backoffMs);
          continue;
        }

        this.logger.error({
          error: error instanceof Error ? error.message : String(error),
          url,
          attempts: maxAttempts
        }, "Request failed after all retries");
      }
    }

    throw lastError ?? new Error("Request failed");
  }

  /**
   * Convenience methods for common HTTP verbs
   */
  get<T = any>(path: string, options?: Parameters<typeof this.request>[2]): Promise<T> {
    return this.request<T>("GET", path, options);
  }

  post<T = any>(path: string, body?: any, options?: Parameters<typeof this.request>[2]): Promise<T> {
    return this.request<T>("POST", path, { ...options, body });
  }

  put<T = any>(path: string, body?: any, options?: Parameters<typeof this.request>[2]): Promise<T> {
    return this.request<T>("PUT", path, { ...options, body });
  }

  delete<T = any>(path: string, options?: Parameters<typeof this.request>[2]): Promise<T> {
    return this.request<T>("DELETE", path, options);
  }

  /**
   * Helper methods
   */
  private buildURL(path: string, query?: Record<string, string>): string {
    let url = `${this.baseURL}${path.startsWith("/") ? "" : "/"}${path}`;

    if (query) {
      const params = new URLSearchParams(query);
      url += `?${params.toString()}`;
    }

    return url;
  }

  private async fetchWithTimeout(url: string, options: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      return response;
    } catch (error) {
      clearTimeout(timeoutId);

      // Add URL context to network errors
      const urlHost = new URL(url).hostname;
      const urlPath = new URL(url).pathname;

      if (error instanceof Error) {
        // Check for abort/timeout
        if (error.name === 'AbortError') {
          throw new Error(`Request timeout after ${this.timeout}ms (host: ${urlHost}, path: ${urlPath})`);
        }
        // Other network errors
        throw new Error(`Unable to connect (host: ${urlHost}, path: ${urlPath}): ${error.message}`);
      }
      throw new Error(`Unable to connect (host: ${urlHost}, path: ${urlPath}): ${String(error)}`);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private exponentialBackoff(attempt: number): number {
    return Math.min(1000 * Math.pow(2, attempt - 1), 10000);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

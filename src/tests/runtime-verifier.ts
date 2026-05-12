import type { Sandbox } from '../tools/sandbox.js';
import type { FileSystemTool } from '../tools/file-system.js';
import { spawn, ChildProcess } from 'child_process';
import * as http from 'http';
import * as https from 'https';

// ============================================================
// Interfaces
// ============================================================

export interface ApiEndpoint {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  expectedStatus?: number;
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
  name?: string;
}

export interface RuntimeVerifyConfig {
  startupTimeout?: number;
  healthCheckTimeout?: number;
  apiTestTimeout?: number;
  port?: number;
  apiEndpoints?: ApiEndpoint[];
}

export interface RuntimeCheck {
  name: string;
  passed: boolean;
  severity: 'critical' | 'major' | 'minor' | 'info';
  output: string;
  error?: string;
  duration: number;
  details?: Record<string, unknown>;
}

export interface RuntimeVerificationResult {
  passed: boolean;
  checks: RuntimeCheck[];
  summary: string;
  duration: number;
  serverOutput: string;
}

// ============================================================
// Internal helpers
// ============================================================

interface StartupDetection {
  command: string;
  args: string[];
  framework: string;
}

/**
 * Extract the port number from a string of server output.
 * Looks for patterns like "port 3000", ":3000", "localhost:3000", etc.
 */
function extractPortFromOutput(output: string): number | null {
  const patterns = [
    /port[:\s]+(\d{1,5})/i,
    /localhost[:\s]+(\d{1,5})/i,
    /0\.0\.0\.0[:\s]+(\d{1,5})/i,
    /127\.0\.0\.1[:\s]+(\d{1,5})/i,
    /listening on.*?(\d{4,5})/i,
    /http:\/\/[^:\/\s]+:(\d{1,5})/i,
  ];

  for (const pattern of patterns) {
    const match = output.match(pattern);
    if (match) {
      const port = parseInt(match[1], 10);
      if (port > 0 && port <= 65535) {
        return port;
      }
    }
  }

  return null;
}

/**
 * Make an HTTP request using only Node.js built-in modules.
 * Returns { statusCode, body, headers }.
 */
function makeHttpRequest(
  url: string,
  method: string,
  body?: Record<string, unknown>,
  headers?: Record<string, string>,
  timeout: number = 10000,
): Promise<{ statusCode: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === 'https:';
    const transport = isHttps ? https : http;

    const payload = body ? JSON.stringify(body) : undefined;

    const requestHeaders: Record<string, string> = {
      ...headers,
      'Accept': 'application/json, text/plain, */*',
    };

    if (payload) {
      requestHeaders['Content-Type'] = 'application/json';
      requestHeaders['Content-Length'] = Buffer.byteLength(payload).toString();
    }

    const req = transport.request(
      {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method,
        headers: requestHeaders,
        timeout,
        rejectUnauthorized: false, // allow self-signed certs in dev
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        res.on('end', () => {
          const bodyStr = Buffer.concat(chunks).toString('utf-8');
          resolve({
            statusCode: res.statusCode ?? 0,
            body: bodyStr,
            headers: res.headers,
          });
        });
      },
    );

    req.on('timeout', () => {
      req.destroy(new Error(`Request timed out after ${timeout}ms`));
    });

    req.on('error', (err) => {
      reject(err);
    });

    if (payload) {
      req.write(payload);
    }

    req.end();
  });
}

// ============================================================
// RuntimeVerifier
// ============================================================

export class RuntimeVerifier {
  private projectRoot: string;
  private fs: FileSystemTool;
  private serverProcess: ChildProcess | null = null;
  private serverOutput: string = '';
  private serverStderr: string = '';

  constructor(_sandbox: Sandbox, projectRoot: string, fs: FileSystemTool) {
    this.projectRoot = projectRoot;
    this.fs = fs;
  }

  /**
   * Main entry point: start the server, run health checks and API tests,
   * then tear down and return results.
   */
  async verify(config?: RuntimeVerifyConfig): Promise<RuntimeVerificationResult> {
    const mergedConfig: Required<Pick<RuntimeVerifyConfig, 'startupTimeout' | 'healthCheckTimeout' | 'apiTestTimeout'>> & {
      port: number;
      apiEndpoints?: ApiEndpoint[];
    } = {
      startupTimeout: config?.startupTimeout ?? 30000,
      healthCheckTimeout: config?.healthCheckTimeout ?? 10000,
      apiTestTimeout: config?.apiTestTimeout ?? 30000,
      port: config?.port ?? 3000,
      apiEndpoints: config?.apiEndpoints,
    };

    const checks: RuntimeCheck[] = [];
    const overallStart = Date.now();

    try {
      // ----------------------------------------------------------
      // Step 1: Detect how to start the server
      // ----------------------------------------------------------
      const startupInfo = await this.detectStartupCommand(mergedConfig.port);

      // ----------------------------------------------------------
      // Step 2: Server Startup Check
      // ----------------------------------------------------------
      const startupCheck = await this.runServerStartupCheck(startupInfo, mergedConfig.startupTimeout);
      checks.push(startupCheck);

      if (!startupCheck.passed) {
        // If the server cannot start, there is no point running further checks.
        return this.buildResult(checks, overallStart);
      }

      // Determine the actual port the server is listening on (may differ from config).
      const detectedPort =
        startupCheck.details?.detectedPort ?? mergedConfig.port;
      const effectivePort = typeof detectedPort === 'number' ? detectedPort : mergedConfig.port;

      // ----------------------------------------------------------
      // Step 3: Health Check
      // ----------------------------------------------------------
      const healthCheck = await this.runHealthCheck(effectivePort, mergedConfig.healthCheckTimeout);
      checks.push(healthCheck);

      // ----------------------------------------------------------
      // Step 4: API Endpoint Testing
      // ----------------------------------------------------------
      const endpoints = mergedConfig.apiEndpoints ?? await this.autoDetectApiEndpoints();
      if (endpoints.length > 0) {
        const apiChecks = await this.runApiTests(effectivePort, endpoints, mergedConfig.apiTestTimeout);
        checks.push(...apiChecks);
      } else {
        checks.push({
          name: 'API Endpoint Testing',
          passed: true,
          severity: 'info',
          output: 'No API endpoints detected or configured. Skipping API tests.',
          duration: 0,
        });
      }
    } finally {
      // ----------------------------------------------------------
      // Step 5: Cleanup - always kill the server process
      // ----------------------------------------------------------
      await this.killServer();
    }

    return this.buildResult(checks, overallStart);
  }

  // ---------------------------------------------------------------
  // Server startup detection
  // ---------------------------------------------------------------

  /**
   * Detect the correct command to start the dev server by inspecting
   * package.json scripts and looking for framework-specific hints.
   */
  private async detectStartupCommand(_defaultPort: number): Promise<StartupDetection> {
    let pkgJson: Record<string, unknown> | null = null;

    try {
      const raw = await this.fs.readFile('package.json');
      pkgJson = JSON.parse(raw);
    } catch {
      // package.json not found or unreadable; fall through to defaults
    }

    if (pkgJson && typeof pkgJson === 'object') {
      const scripts = pkgJson['scripts'] as Record<string, string> | undefined;

      if (scripts) {
        // Priority order of scripts to try
        const scriptPriority = ['dev', 'start', 'serve'];

        for (const scriptName of scriptPriority) {
          const scriptValue = scripts[scriptName];
          if (scriptValue) {
            const framework = this.detectFramework(scriptValue, pkgJson);
            return {
              command: 'npm',
              args: ['run', scriptName],
              framework,
            };
          }
        }
      }

      // Check dependencies for framework hints
      const deps = {
        ...(pkgJson['dependencies'] as Record<string, string> | undefined),
        ...(pkgJson['devDependencies'] as Record<string, string> | undefined),
      };

      if (deps) {
        if (deps['next']) {
          return {
            command: 'npm',
            args: ['run', 'dev'],
            framework: 'Next.js',
          };
        }
        if (deps['vite']) {
          return {
            command: 'npm',
            args: ['run', 'dev'],
            framework: 'Vite',
          };
        }
        if (deps['express']) {
          return {
            command: 'npm',
            args: ['run', 'start'],
            framework: 'Express',
          };
        }
        if (deps['nestjs'] || deps['@nestjs/core']) {
          return {
            command: 'npm',
            args: ['run', 'start:dev'],
            framework: 'NestJS',
          };
        }
      }
    }

    // Fallback: try to use the sandbox's startDevServer, or run `node index.js`
    return {
      command: 'node',
      args: ['index.js'],
      framework: 'Unknown',
    };
  }

  /**
   * Detect the framework from a script value and package.json metadata.
   */
  private detectFramework(scriptValue: string, pkgJson: Record<string, unknown>): string {
    const lower = scriptValue.toLowerCase();

    if (lower.includes('next')) return 'Next.js';
    if (lower.includes('vite')) return 'Vite';
    if (lower.includes('nuxt')) return 'Nuxt.js';
    if (lower.includes('astro')) return 'Astro';
    if (lower.includes('svelte-kit') || lower.includes('sveltekit')) return 'SvelteKit';
    if (lower.includes('remix')) return 'Remix';
    if (lower.includes('nest')) return 'NestJS';
    if (lower.includes('ts-node') || lower.includes('tsx')) return 'TypeScript (tsx/ts-node)';
    if (lower.includes('nodemon')) return 'Node.js (nodemon)';
    if (lower.includes('vue')) return 'Vue CLI';

    // Check dependencies
    const deps = {
      ...(pkgJson['dependencies'] as Record<string, string> | undefined),
      ...(pkgJson['devDependencies'] as Record<string, string> | undefined),
    };

    if (deps?.['express']) return 'Express';
    if (deps?.['fastify']) return 'Fastify';
    if (deps?.['koa']) return 'Koa';
    if (deps?.['hapi'] || deps?.['@hapi/hapi']) return 'Hapi';

    return 'Unknown';
  }

  // ---------------------------------------------------------------
  // Server startup
  // ---------------------------------------------------------------

  /**
   * Start the server process and wait for it to signal readiness.
   */
  private async runServerStartupCheck(
    startupInfo: StartupDetection,
    timeout: number,
  ): Promise<RuntimeCheck> {
    const start = Date.now();
    this.serverOutput = '';
    this.serverStderr = '';

    return new Promise<RuntimeCheck>((resolve) => {
      let settled = false;

      const finish = (check: RuntimeCheck) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(check);
      };

      // Timeout guard
      const timer = setTimeout(() => {
        finish({
          name: 'Server Startup',
          passed: false,
          severity: 'critical',
          output: `Server failed to start within ${timeout}ms.`,
          error: 'Startup timeout exceeded.',
          duration: Date.now() - start,
          details: {
            command: `${startupInfo.command} ${startupInfo.args.join(' ')}`,
            framework: startupInfo.framework,
            stdout: this.serverOutput.slice(-2000),
            stderr: this.serverStderr.slice(-2000),
          },
        });
      }, timeout);

      // Readiness indicators to watch for in stdout/stderr
      const readinessPatterns = [
        'ready',
        'started',
        'listening',
        'localhost',
        'http://',
        'https://',
        'compiled successfully',
        'server is running',
        'app is running',
        'bound to',
      ];

      const checkReadiness = (data: string) => {
        const lower = data.toLowerCase();
        for (const pattern of readinessPatterns) {
          if (lower.includes(pattern)) {
            const detectedPort = extractPortFromOutput(this.serverOutput + this.serverStderr);
            finish({
              name: 'Server Startup',
              passed: true,
              severity: 'critical',
              output: `Server started successfully using ${startupInfo.framework} (${startupInfo.command} ${startupInfo.args.join(' ')}).`,
              duration: Date.now() - start,
              details: {
                command: `${startupInfo.command} ${startupInfo.args.join(' ')}`,
                framework: startupInfo.framework,
                detectedPort: detectedPort ?? 'auto',
              },
            });
            return;
          }
        }
      };

      try {
        // Try the sandbox startDevServer first if available
        const child = spawn(startupInfo.command, startupInfo.args, {
          cwd: this.projectRoot,
          env: {
            ...process.env,
            NODE_ENV: 'development',
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        this.serverProcess = child;

        child.stdout?.on('data', (data: Buffer) => {
          const text = data.toString();
          this.serverOutput += text;
          checkReadiness(text);
        });

        child.stderr?.on('data', (data: Buffer) => {
          const text = data.toString();
          this.serverStderr += text;
          // Some frameworks log readiness to stderr (e.g., Vite)
          checkReadiness(text);
        });

        child.on('error', (err) => {
          finish({
            name: 'Server Startup',
            passed: false,
            severity: 'critical',
            output: `Failed to spawn server process: ${err.message}`,
            error: err.message,
            duration: Date.now() - start,
            details: {
              command: `${startupInfo.command} ${startupInfo.args.join(' ')}`,
              framework: startupInfo.framework,
            },
          });
        });

        child.on('exit', (code, signal) => {
          if (!settled) {
            this.serverProcess = null;
            finish({
              name: 'Server Startup',
              passed: false,
              severity: 'critical',
              output: `Server process exited prematurely with code ${code} (signal: ${signal}).`,
              error: `Process exited with code ${code}`,
              duration: Date.now() - start,
              details: {
                command: `${startupInfo.command} ${startupInfo.args.join(' ')}`,
                framework: startupInfo.framework,
                exitCode: code,
                signal,
                stdout: this.serverOutput.slice(-2000),
                stderr: this.serverStderr.slice(-2000),
              },
            });
          }
        });
      } catch (err) {
        finish({
          name: 'Server Startup',
          passed: false,
          severity: 'critical',
          output: `Exception while starting server: ${err instanceof Error ? err.message : String(err)}`,
          error: err instanceof Error ? err.message : String(err),
          duration: Date.now() - start,
          details: {
            command: `${startupInfo.command} ${startupInfo.args.join(' ')}`,
            framework: startupInfo.framework,
          },
        });
      }
    });
  }

  // ---------------------------------------------------------------
  // Health check
  // ---------------------------------------------------------------

  /**
   * Attempt to connect to the server root and common health endpoints.
   */
  private async runHealthCheck(port: number, timeout: number): Promise<RuntimeCheck> {
    const start = Date.now();
    const baseUrl = `http://localhost:${port}`;

    // Ordered list of health endpoints to try
    const healthPaths = ['/', '/health', '/api/health', '/api/status', '/status', '/ping'];

    for (const healthPath of healthPaths) {
      try {
        const response = await makeHttpRequest(`${baseUrl}${healthPath}`, 'GET', undefined, undefined, timeout);

        if (response.statusCode >= 200 && response.statusCode < 500) {
          // Any 2xx-4xx means the server is responsive.
          // 2xx is ideal, 3xx redirect is acceptable, 4xx means route may not exist
          // but the server is alive.
          const isHealthy = response.statusCode >= 200 && response.statusCode < 400;

          return {
            name: healthPath === '/' ? 'Health Check (Root)' : `Health Check (${healthPath})`,
            passed: isHealthy,
            severity: isHealthy ? 'major' : 'minor',
            output: isHealthy
              ? `Server responded with HTTP ${response.statusCode} at ${baseUrl}${healthPath}`
              : `Server is reachable but returned HTTP ${response.statusCode} at ${baseUrl}${healthPath}`,
            duration: Date.now() - start,
            details: {
              url: `${baseUrl}${healthPath}`,
              statusCode: response.statusCode,
              bodyPreview: response.body.slice(0, 500),
            },
          };
        }
      } catch {
        // Connection refused or timeout -- try next endpoint
        continue;
      }
    }

    // None of the health endpoints responded
    return {
      name: 'Health Check',
      passed: false,
      severity: 'major',
      output: `Could not connect to server at ${baseUrl}. All health endpoints failed.`,
      error: 'Server not reachable',
      duration: Date.now() - start,
      details: {
        triedEndpoints: healthPaths,
        serverStderr: this.serverStderr.slice(-1000),
      },
    };
  }

  // ---------------------------------------------------------------
  // API endpoint testing
  // ---------------------------------------------------------------

  /**
   * Test each provided API endpoint and return a RuntimeCheck per endpoint.
   */
  private async runApiTests(
    port: number,
    endpoints: ApiEndpoint[],
    timeout: number,
  ): Promise<RuntimeCheck[]> {
    const baseUrl = `http://localhost:${port}`;
    const checks: RuntimeCheck[] = [];

    for (const endpoint of endpoints) {
      const start = Date.now();
      const label = endpoint.name ?? `API: ${endpoint.method} ${endpoint.path}`;

      try {
        const response = await makeHttpRequest(
          `${baseUrl}${endpoint.path}`,
          endpoint.method,
          endpoint.body,
          endpoint.headers,
          timeout,
        );

        const expected = endpoint.expectedStatus ?? 200;
        const passed = response.statusCode === expected;

        checks.push({
          name: label,
          passed,
          severity: passed ? 'minor' : 'major',
          output: passed
            ? `${endpoint.method} ${endpoint.path} returned ${response.statusCode} (expected ${expected})`
            : `${endpoint.method} ${endpoint.path} returned ${response.statusCode} (expected ${expected})`,
          error: passed ? undefined : `Status code mismatch: got ${response.statusCode}, expected ${expected}`,
          duration: Date.now() - start,
          details: {
            method: endpoint.method,
            path: endpoint.path,
            expectedStatus: expected,
            actualStatus: response.statusCode,
            bodyPreview: response.body.slice(0, 500),
          },
        });
      } catch (err) {
        checks.push({
          name: label,
          passed: false,
          severity: 'major',
          output: `${endpoint.method} ${endpoint.path} request failed`,
          error: err instanceof Error ? err.message : String(err),
          duration: Date.now() - start,
          details: {
            method: endpoint.method,
            path: endpoint.path,
          },
        });
      }
    }

    return checks;
  }

  // ---------------------------------------------------------------
  // Auto-detection of API endpoints
  // ---------------------------------------------------------------

  /**
   * Scan the codebase for Express-style route definitions and Next.js
   * API route files to build a list of endpoints to test.
   */
  private async autoDetectApiEndpoints(): Promise<ApiEndpoint[]> {
    const endpoints: ApiEndpoint[] = [];
    const seen = new Set<string>();

    const addEndpoint = (method: ApiEndpoint['method'], path: string) => {
      const key = `${method} ${path}`;
      if (seen.has(key)) return;
      seen.add(key);
      endpoints.push({ method, path });
    };

    try {
      // 1. Scan for Express / Connect routes in source files
      const sourceFiles = await this.findSourceFiles();
      for (const filePath of sourceFiles) {
        try {
          const content = await this.fs.readFile(filePath);
          this.extractExpressRoutes(content, addEndpoint);
        } catch {
          // Skip unreadable files
        }
      }

      // 2. Scan for Next.js API routes
      const nextEndpoints = await this.detectNextJsApiRoutes();
      for (const ep of nextEndpoints) {
        addEndpoint(ep.method, ep.path);
      }
    } catch {
      // Auto-detection is best-effort; swallow errors silently
    }

    return endpoints;
  }

  /**
   * Find all JavaScript/TypeScript source files in the project.
   */
  private async findSourceFiles(): Promise<string[]> {
    const extensions = ['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs'];
    const files: string[] = [];

    try {
      const allFiles = await this.fs.listAllFiles();
      for (const file of allFiles) {
        // Skip node_modules, dist, build, .next directories
        if (
          file.includes('node_modules/') ||
          file.includes('/dist/') ||
          file.includes('/build/') ||
          file.includes('/.next/') ||
          file.includes('/coverage/')
        ) {
          continue;
        }
        if (extensions.some((ext) => file.endsWith(ext))) {
          files.push(file);
        }
      }
    } catch {
      // Best-effort
    }

    return files;
  }

  /**
   * Extract Express-style route definitions from source code content.
   * Handles patterns like:
   *   app.get('/path', ...)
   *   app.post('/path', ...)
   *   router.get('/path', ...)
   *   router.put('/path', ...)
   *   router.delete('/path', ...)
   *   router.patch('/path', ...)
   */
  private extractExpressRoutes(
    content: string,
    addEndpoint: (method: ApiEndpoint['method'], path: string) => void,
  ): void {
    // Match patterns: <object>.<method>('<path>' or "<path>",
    // where object is app, router, server, or api
    const routePattern = /\b(app|router|server|api)\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`\s]+)['"`]/gi;

    let match: RegExpExecArray | null;
    while ((match = routePattern.exec(content)) !== null) {
      const method = match[2].toUpperCase() as ApiEndpoint['method'];
      let path = match[3];

      // Normalize path: remove trailing commas or closing parens that may have been captured
      path = path.replace(/[,)\s]+$/, '');

      // Skip parameterized paths that are clearly not literal (e.g., variables)
      if (path.startsWith('$') || path.startsWith('process')) continue;

      addEndpoint(method, path);
    }
  }

  /**
   * Detect Next.js API routes by scanning the file system for
   * files in app/api/ or pages/api/ directories.
   */
  private async detectNextJsApiRoutes(): Promise<ApiEndpoint[]> {
    const endpoints: ApiEndpoint[] = [];

    // Next.js App Router: app/api/**/*.ts, app/api/**/*.js
    // The HTTP method is determined by named exports (GET, POST, etc.)
    const appApiDirs = ['app/api', 'src/app/api'];
    for (const dir of appApiDirs) {
      const routes = await this.scanNextAppApiDir(dir);
      endpoints.push(...routes);
    }

    // Next.js Pages Router: pages/api/**/*.ts, pages/api/**/*.js
    const pagesApiDirs = ['pages/api', 'src/pages/api'];
    for (const dir of pagesApiDirs) {
      const routes = await this.scanNextPagesApiDir(dir);
      endpoints.push(...routes);
    }

    return endpoints;
  }

  /**
   * Scan a Next.js App Router API directory for route handlers.
   * Each file/folder maps to a route path. HTTP methods are inferred
   * from exported function names (GET, POST, PUT, DELETE, PATCH).
   */
  private async scanNextAppApiDir(baseDir: string): Promise<ApiEndpoint[]> {
    const endpoints: ApiEndpoint[] = [];
    const httpMethodExports = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];

    try {
      const allFiles = await this.fs.listAllFiles(baseDir);
      for (const filePath of allFiles) {
        // Only look at route handler files
        if (!filePath.endsWith('route.ts') && !filePath.endsWith('route.js')) {
          continue;
        }

        // Derive the route path from the file path
        // e.g., "app/api/users/route.ts" -> "/api/users"
        // e.g., "app/api/users/[id]/route.ts" -> "/api/users/:id"
        const relativeDir = filePath
          .replace(/\/route\.(ts|js)$/, '')
          .replace(baseDir, '');

        const pathSegments = relativeDir
          .split('/')
          .filter(Boolean)
          .map((seg) => {
            // Convert Next.js dynamic segments [param] to Express-style :param
            if (seg.startsWith('[') && seg.endsWith(']')) {
              return ':' + seg.slice(1, -1);
            }
            return seg;
          });

        const routePath = '/api/' + pathSegments.join('/');

        // Read the file to detect which HTTP methods are exported
        try {
          const content = await this.fs.readFile(filePath);
          for (const method of httpMethodExports) {
            // Look for `export async function GET(` or `export function POST(`
            const exportPattern = new RegExp(`export\\s+(?:async\\s+)?function\\s+${method}\\s*\\(`, 'i');
            if (exportPattern.test(content)) {
              endpoints.push({
                method: method as ApiEndpoint['method'],
                path: routePath,
              });
            }
          }
        } catch {
          // If we cannot read the file, add a default GET endpoint
          endpoints.push({ method: 'GET', path: routePath });
        }
      }
    } catch {
      // Directory may not exist; skip
    }

    return endpoints;
  }

  /**
   * Scan a Next.js Pages Router API directory for route handlers.
   * Each .ts/.js file maps to a route path. Default export handles all methods.
   */
  private async scanNextPagesApiDir(baseDir: string): Promise<ApiEndpoint[]> {
    const endpoints: ApiEndpoint[] = [];

    try {
      const allFiles = await this.fs.listAllFiles(baseDir);
      for (const filePath of allFiles) {
        if (!filePath.endsWith('.ts') && !filePath.endsWith('.js')) continue;

        // Derive the route path
        const relativePath = filePath.replace(baseDir, '').replace(/\.(ts|js)$/, '');
        const pathSegments = relativePath
          .split('/')
          .filter(Boolean)
          .map((seg) => {
            if (seg.startsWith('[') && seg.endsWith(']')) {
              return ':' + seg.slice(1, -1);
            }
            return seg;
          });

        const routePath = '/api/' + pathSegments.join('/');

        // Default: assume GET for pages router
        endpoints.push({ method: 'GET', path: routePath });
      }
    } catch {
      // Directory may not exist; skip
    }

    return endpoints;
  }

  // ---------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------

  /**
   * Kill the server process if it is running. Uses SIGTERM first,
   * then SIGKILL after a grace period.
   */
  private async killServer(): Promise<void> {
    if (!this.serverProcess || this.serverProcess.killed) {
      this.serverProcess = null;
      return;
    }

    const proc = this.serverProcess;

    return new Promise<void>((resolve) => {
      const forceKillTimeout = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          // Process may already be dead
        }
        this.serverProcess = null;
        resolve();
      }, 5000);

      proc.on('close', () => {
        clearTimeout(forceKillTimeout);
        this.serverProcess = null;
        resolve();
      });

      proc.on('error', () => {
        clearTimeout(forceKillTimeout);
        this.serverProcess = null;
        resolve();
      });

      try {
        proc.kill('SIGTERM');
      } catch {
        // Process may already be dead
        clearTimeout(forceKillTimeout);
        this.serverProcess = null;
        resolve();
      }
    });
  }

  // ---------------------------------------------------------------
  // Result building
  // ---------------------------------------------------------------

  /**
   * Build the final RuntimeVerificationResult from all collected checks.
   */
  private buildResult(checks: RuntimeCheck[], overallStart: number): RuntimeVerificationResult {
    const duration = Date.now() - overallStart;
    const passed = checks.every((c) => c.passed);

    const criticalFailures = checks.filter((c) => !c.passed && c.severity === 'critical').length;
    const majorFailures = checks.filter((c) => !c.passed && c.severity === 'major').length;
    const minorFailures = checks.filter((c) => !c.passed && c.severity === 'minor').length;
    const totalPassed = checks.filter((c) => c.passed).length;

    let summary: string;
    if (passed) {
      summary = `All ${checks.length} runtime checks passed in ${duration}ms.`;
    } else {
      const parts: string[] = [];
      if (criticalFailures > 0) parts.push(`${criticalFailures} critical`);
      if (majorFailures > 0) parts.push(`${majorFailures} major`);
      if (minorFailures > 0) parts.push(`${minorFailures} minor`);
      summary = `${totalPassed}/${checks.length} checks passed (${parts.join(', ')} failures) in ${duration}ms.`;
    }

    return {
      passed,
      checks,
      summary,
      duration,
      serverOutput: (this.serverOutput + '\n' + this.serverStderr).trim(),
    };
  }
}

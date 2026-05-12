import type { Sandbox, SandboxExecutionResult } from '../tools/sandbox.js';
import type { FileSystemTool } from '../tools/file-system.js';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface StaticCheck {
  /** Human-readable name of the check, e.g. "TypeScript Compilation" */
  name: string;
  /** Whether the check passed overall */
  passed: boolean;
  /** Severity level of the worst issue found */
  severity: 'critical' | 'major' | 'minor' | 'info';
  /** Combined stdout + stderr from the tool invocation */
  output: string;
  /** Optional high-level error description when the check could not run */
  error?: string;
  /** Wall-clock time in milliseconds */
  duration: number;
  /** Source file related to the most significant issue (if applicable) */
  file?: string;
  /** Line number related to the most significant issue (if applicable) */
  line?: number;
}

export interface StaticVerificationResult {
  /** `true` when every check passed */
  passed: boolean;
  /** Individual check results */
  checks: StaticCheck[];
  /** Human-readable summary of the verification run */
  summary: string;
  /** Total wall-clock time in milliseconds */
  duration: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface ProjectManifest {
  hasTypeScript: boolean;
  hasEslint: boolean;
  hasBuildScript: boolean;
  hasLintScript: boolean;
  isNextJs: boolean;
}

interface EslintMessage {
  ruleId: string | null;
  severity: number; // 1 = warn, 2 = error
  message: string;
  line: number;
  column: number;
  filePath?: string;
}

interface EslintFileResult {
  filePath: string;
  messages: EslintMessage[];
  errorCount: number;
  warningCount: number;
}

/**
 * Attempt to read and parse a JSON file. Returns `null` when the file does
 * not exist or cannot be parsed.
 */
async function readJsonSafe(
  fs: FileSystemTool,
  filePath: string,
): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(filePath);
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Extract file:line information from a TypeScript error line.
 *
 * Expected patterns:
 *   src/foo.ts(12,5): error TS2304: Cannot find name 'bar'.
 *   src/foo.ts:12:5 - error TS2304: Cannot find name 'bar'.
 */
function parseTsErrorLine(line: string): { file?: string; line?: number } | null {
  // Pattern: path(line,col): error TSxxxx: ...
  const parens = line.match(/^(.+?)\((\d+),\d+\):\s+error\s+TS\d+:/);
  if (parens) {
    return { file: parens[1], line: parseInt(parens[2], 10) };
  }
  // Pattern: path:line:col - error TSxxxx: ...
  const colon = line.match(/^(.+?):(\d+):\d+\s+-\s+error\s+TS\d+:/);
  if (colon) {
    return { file: colon[1], line: parseInt(colon[2], 10) };
  }
  return null;
}

/**
 * Extract the most relevant file:line from a block of TypeScript output.
 */
function extractTsFileInfo(stderr: string): { file?: string; line?: number } {
  const lines = stderr.split('\n');
  for (const line of lines) {
    const parsed = parseTsErrorLine(line);
    if (parsed) {
      return parsed;
    }
  }
  return {};
}

// ---------------------------------------------------------------------------
// StaticVerifier
// ---------------------------------------------------------------------------

export class StaticVerifier {
  private readonly sandbox: Sandbox;
  private readonly projectRoot: string;
  private readonly fs: FileSystemTool;

  constructor(sandbox: Sandbox, projectRoot: string, fs: FileSystemTool) {
    this.sandbox = sandbox;
    this.projectRoot = projectRoot;
    this.fs = fs;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Run all applicable static-analysis checks against the project and return
   * a consolidated result.
   */
  async verify(): Promise<StaticVerificationResult> {
    const overallStart = Date.now();
    const checks: StaticCheck[] = [];

    let manifest: ProjectManifest;
    try {
      manifest = await this.detectProjectType();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[StaticVerifier] Failed to detect project type: ${message}`);

      return {
        passed: false,
        checks: [
          {
            name: 'Project Detection',
            passed: false,
            severity: 'critical',
            output: '',
            error: `Unable to detect project type: ${message}`,
            duration: Date.now() - overallStart,
          },
        ],
        summary: 'Static verification could not start — project type detection failed.',
        duration: Date.now() - overallStart,
      };
    }

    // 1. TypeScript compilation
    if (manifest.hasTypeScript) {
      const check = await this.runTypeScriptCheck();
      checks.push(check);
    }

    // 2. ESLint (standalone invocation)
    if (manifest.hasEslint) {
      const check = await this.runEslintCheck(manifest.isNextJs);
      checks.push(check);
    }

    // 3. Lint script (only when not already covered by the standalone ESLint run)
    if (manifest.hasLintScript && !manifest.hasEslint) {
      const check = await this.runNpmScriptCheck('lint', 'Lint Script', 30_000);
      checks.push(check);
    }

    // 4. Build script
    if (manifest.hasBuildScript) {
      const check = await this.runNpmScriptCheck('build', 'Build', 60_000);
      checks.push(check);
    }

    const overallDuration = Date.now() - overallStart;
    const allPassed = checks.every((c) => c.passed);

    const summary = this.buildSummary(checks, allPassed, overallDuration);

    return {
      passed: allPassed,
      checks,
      summary,
      duration: overallDuration,
    };
  }

  // -----------------------------------------------------------------------
  // Project detection
  // -----------------------------------------------------------------------

  private async detectProjectType(): Promise<ProjectManifest> {
    const pkgPath = `${this.projectRoot}/package.json`;
    const pkg = await readJsonSafe(this.fs, pkgPath);

    if (!pkg) {
      throw new Error(`package.json not found or invalid at ${pkgPath}`);
    }

    const devDeps = (pkg.devDependencies ?? {}) as Record<string, string>;
    const deps = (pkg.dependencies ?? {}) as Record<string, string>;
    const scripts = (pkg.scripts ?? {}) as Record<string, string>;

    const hasTypeScript = 'typescript' in devDeps || 'typescript' in deps;

    // ESLint may be present as a dependency or via a config file
    const hasEslintDep = 'eslint' in devDeps || 'eslint' in deps;
    const hasEslintConfig = await this.hasEslintConfigFile();
    const hasEslint = hasEslintDep || hasEslintConfig;

    const hasBuildScript = typeof scripts.build === 'string' && scripts.build.length > 0;
    const hasLintScript = typeof scripts.lint === 'string' && scripts.lint.length > 0;

    const allDeps = { ...devDeps, ...deps };
    const isNextJs = '@next/eslint-plugin-next' in allDeps || 'next' in allDeps;

    console.log('[StaticVerifier] Project detection complete:', {
      hasTypeScript,
      hasEslint,
      hasBuildScript,
      hasLintScript,
      isNextJs,
    });

    return { hasTypeScript, hasEslint, hasBuildScript, hasLintScript, isNextJs };
  }

  private async hasEslintConfigFile(): Promise<boolean> {
    const candidates = [
      '.eslintrc.js',
      '.eslintrc.cjs',
      '.eslintrc.yaml',
      '.eslintrc.yml',
      '.eslintrc.json',
      '.eslintrc',
      'eslint.config.js',
      'eslint.config.mjs',
      'eslint.config.cjs',
    ];

    for (const name of candidates) {
      try {
        await this.fs.readFile(`${this.projectRoot}/${name}`);
        return true;
      } catch {
        // file does not exist — continue
      }
    }
    return false;
  }

  // -----------------------------------------------------------------------
  // Individual checks
  // -----------------------------------------------------------------------

  private async runTypeScriptCheck(): Promise<StaticCheck> {
    const name = 'TypeScript Compilation';
    const start = Date.now();

    console.log(`[StaticVerifier] Running: ${name}`);

    let result: SandboxExecutionResult;
    try {
      result = await this.sandbox.execute('npx', ['tsc', '--noEmit'], this.projectRoot);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        name,
        passed: false,
        severity: 'critical',
        output: '',
        error: `Failed to execute tsc: ${message}`,
        duration: Date.now() - start,
      };
    }

    const combined = [result.stdout ?? '', result.stderr ?? ''].join('\n').trim();
    const exitCode = result.exitCode ?? 1;
    const passed = exitCode === 0;

    const { file, line } = extractTsFileInfo(result.stderr ?? '');

    console.log(
      `[StaticVerifier] ${name} — ${passed ? 'PASSED' : 'FAILED'} (${Date.now() - start}ms)`,
    );

    return {
      name,
      passed,
      severity: passed ? 'info' : 'critical',
      output: combined,
      duration: Date.now() - start,
      file,
      line,
    };
  }

  private async runEslintCheck(_isNextJs: boolean): Promise<StaticCheck> {
    const name = 'ESLint';
    const start = Date.now();

    console.log(`[StaticVerifier] Running: ${name}`);

    // Build the eslint command. We request JSON output so we can parse
    // individual issues. For Next.js projects we rely on the project's own
    // eslint config which should already include the Next.js plugin.
    const ext = '.ts,.tsx,.js,.jsx';

    let result: SandboxExecutionResult;
    try {
      result = await this.sandbox.execute('npx', ['eslint', '.', '--ext', ext, '--format', 'json'], this.projectRoot);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        name,
        passed: false,
        severity: 'major',
        output: '',
        error: `Failed to execute eslint: ${message}`,
        duration: Date.now() - start,
      };
    }

    const combined = [result.stdout ?? '', result.stderr ?? ''].join('\n').trim();
    const exitCode = result.exitCode ?? 1;
    const passed = exitCode === 0;

    // Try to parse the JSON output for richer diagnostics
    let parsedFiles: EslintFileResult[] | null = null;
    if (result.stdout) {
      try {
        const raw = JSON.parse(result.stdout);
        // ESLint JSON format is an array of file results
        if (Array.isArray(raw)) {
          parsedFiles = raw as EslintFileResult[];
        }
      } catch {
        // Not valid JSON — fall back to raw output
        console.warn('[StaticVerifier] ESLint output was not valid JSON; using raw output.');
      }
    }

    let worstSeverity: 'info' | 'major' | 'minor' | 'critical' = 'info';
    let worstFile: string | undefined;
    let worstLine: number | undefined;

    if (parsedFiles) {
      for (const fileResult of parsedFiles) {
        for (const msg of fileResult.messages) {
          if (msg.severity === 2) {
            worstSeverity = 'major';
            worstFile = fileResult.filePath;
            worstLine = msg.line;
          } else if (msg.severity === 1 && worstSeverity === 'info') {
            worstSeverity = 'minor';
            worstFile = fileResult.filePath;
            worstLine = msg.line;
          }
        }
      }
    } else if (!passed) {
      // Could not parse JSON but the command failed — treat as major
      worstSeverity = 'major';
    }

    console.log(
      `[StaticVerifier] ${name} — ${passed ? 'PASSED' : 'FAILED'} (${Date.now() - start}ms)`,
    );

    return {
      name,
      passed,
      severity: worstSeverity,
      output: combined,
      duration: Date.now() - start,
      file: worstFile,
      line: worstLine,
    };
  }

  private async runNpmScriptCheck(
    scriptName: string,
    displayName: string,
    _timeoutMs: number,
  ): Promise<StaticCheck> {
    const start = Date.now();

    console.log(`[StaticVerifier] Running: ${displayName} (npm run ${scriptName})`);

    let result: SandboxExecutionResult;
    try {
      result = await this.sandbox.execute('npm', ['run', scriptName], this.projectRoot);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        name: displayName,
        passed: false,
        severity: 'major',
        output: '',
        error: `Failed to execute "npm run ${scriptName}": ${message}`,
        duration: Date.now() - start,
      };
    }

    const combined = [result.stdout ?? '', result.stderr ?? ''].join('\n').trim();
    const exitCode = result.exitCode ?? 1;
    const passed = exitCode === 0;

    // For build failures we treat them as critical; lint script failures are
    // major at most.
    const severity: StaticCheck['severity'] = passed
      ? 'info'
      : scriptName === 'build'
        ? 'critical'
        : 'major';

    console.log(
      `[StaticVerifier] ${displayName} — ${passed ? 'PASSED' : 'FAILED'} (${Date.now() - start}ms)`,
    );

    return {
      name: displayName,
      passed,
      severity,
      output: combined,
      duration: Date.now() - start,
    };
  }

  // -----------------------------------------------------------------------
  // Summary builder
  // -----------------------------------------------------------------------

  private buildSummary(
    checks: StaticCheck[],
    allPassed: boolean,
    totalDuration: number,
  ): string {
    if (checks.length === 0) {
      return 'No static checks were applicable for this project.';
    }

    const failed = checks.filter((c) => !c.passed).length;

    const parts: string[] = [];

    if (allPassed) {
      parts.push(
        `All ${checks.length} static check${checks.length === 1 ? '' : 's'} passed.`,
      );
    } else {
      parts.push(
        `${failed} of ${checks.length} check${checks.length === 1 ? '' : 's'} failed.`,
      );
    }

    for (const check of checks) {
      const status = check.passed ? 'PASS' : 'FAIL';
      parts.push(`  [${status}] ${check.name} (${check.severity}) — ${check.duration}ms`);
      if (!check.passed && check.file) {
        const loc = check.line != null ? `:${check.line}` : '';
        parts.push(`         ${check.file}${loc}`);
      }
    }

    parts.push(`Total time: ${totalDuration}ms`);

    return parts.join('\n');
  }
}

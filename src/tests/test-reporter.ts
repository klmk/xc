import { randomUUID } from 'crypto';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';

import type { StaticVerificationResult } from './static-verifier.js';
import type { RuntimeVerificationResult } from './runtime-verifier.js';
import type { BusinessVerificationResult } from './business-verifier.js';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/** A single issue found during any verification phase. */
export interface TestIssue {
  /** Unique identifier, e.g. "STATIC-TSC-001", "RUNTIME-API-003", "BIZ-SCEN-002" */
  id: string;
  /** Which verification layer produced this issue */
  phase: 'static' | 'runtime' | 'business';
  severity: 'critical' | 'major' | 'minor' | 'info';
  /** e.g. "compilation", "lint", "api", "startup", "scenario" */
  category: string;
  /** e.g. "auth", "api/users" */
  module: string;
  file?: string;
  line?: number;
  description: string;
  suggestion?: string;
  /** Original tool output for debugging */
  rawOutput?: string;
}

/** Aggregated test report spanning all verification layers. */
export interface TestReport {
  reportId: string;
  timestamp: string;
  projectRoot: string;
  overallResult: 'pass' | 'fail' | 'warn';

  static: {
    included: boolean;
    passed: boolean;
    duration: number;
    checks: number;
    issues: TestIssue[];
  };
  runtime: {
    included: boolean;
    passed: boolean;
    duration: number;
    checks: number;
    issues: TestIssue[];
  };
  business: {
    included: boolean;
    passed: boolean;
    duration: number;
    scenarios: number;
    scenariosPassed: number;
    issues: TestIssue[];
  };

  stats: {
    totalIssues: number;
    critical: number;
    major: number;
    minor: number;
    info: number;
    totalDuration: number;
  };

  /** Human-readable summary */
  summary: string;
}

// ---------------------------------------------------------------------------
// Severity ordering (lower index = higher severity)
// ---------------------------------------------------------------------------

const SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  major: 1,
  minor: 2,
  info: 3,
};

// ---------------------------------------------------------------------------
// TestReporter
// ---------------------------------------------------------------------------

export class TestReporter {
  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Generate a structured test report from the results of all three
   * verification layers.
   */
  generateReport(params: {
    static?: StaticVerificationResult;
    runtime?: RuntimeVerificationResult;
    business?: BusinessVerificationResult;
    projectRoot: string;
  }): TestReport {
    const { static: staticResult, runtime: runtimeResult, business: businessResult, projectRoot } = params;

    // --- Static phase ---
    const staticIssues = staticResult
      ? this.normalizeStaticIssues(staticResult)
      : [];

    // --- Runtime phase ---
    const runtimeIssues = runtimeResult
      ? this.normalizeRuntimeIssues(runtimeResult)
      : [];

    // --- Business phase ---
    const businessIssues = businessResult
      ? this.normalizeBusinessIssues(businessResult)
      : [];

    // --- Collect all issues for overall assessment ---
    const allIssues = [...staticIssues, ...runtimeIssues, ...businessIssues];

    const hasCritical = allIssues.some((i) => i.severity === 'critical');
    const hasMajor = allIssues.some((i) => i.severity === 'major');

    const overallResult: TestReport['overallResult'] = hasCritical
      ? 'fail'
      : hasMajor
        ? 'warn'
        : 'pass';

    // --- Stats ---
    const stats = {
      totalIssues: allIssues.length,
      critical: allIssues.filter((i) => i.severity === 'critical').length,
      major: allIssues.filter((i) => i.severity === 'major').length,
      minor: allIssues.filter((i) => i.severity === 'minor').length,
      info: allIssues.filter((i) => i.severity === 'info').length,
      totalDuration:
        (staticResult?.duration ?? 0) +
        (runtimeResult?.duration ?? 0) +
        (businessResult?.duration ?? 0),
    };

    // --- Summary ---
    const summary = this.buildSummary(
      overallResult,
      staticResult,
      runtimeResult,
      businessResult,
      stats,
    );

    return {
      reportId: randomUUID(),
      timestamp: new Date().toISOString(),
      projectRoot,
      overallResult,

      static: {
        included: staticResult != null,
        passed: staticResult?.passed ?? false,
        duration: staticResult?.duration ?? 0,
        checks: staticResult?.checks.length ?? 0,
        issues: staticIssues,
      },

      runtime: {
        included: runtimeResult != null,
        passed: runtimeResult?.passed ?? false,
        duration: runtimeResult?.duration ?? 0,
        checks: runtimeResult?.checks.length ?? 0,
        issues: runtimeIssues,
      },

      business: {
        included: businessResult != null,
        passed: businessResult?.passed ?? false,
        duration: businessResult?.duration ?? 0,
        scenarios: businessResult?.scenarios.length ?? 0,
        scenariosPassed: businessResult?.scenarios.filter((s) => s.passed).length ?? 0,
        issues: businessIssues,
      },

      stats,
      summary,
    };
  }

  /**
   * Serialize a TestReport to a pretty-printed JSON string.
   */
  toJSON(report: TestReport): string {
    return JSON.stringify(report, null, 2);
  }

  /**
   * Render a TestReport as a human-readable Markdown document.
   */
  toMarkdown(report: TestReport): string {
    const lines: string[] = [];

    // --- Header ---
    const badge = this.resultBadge(report.overallResult);
    lines.push(`# Test Report ${badge}`);
    lines.push('');
    lines.push(`- **Report ID:** \`${report.reportId}\``);
    lines.push(`- **Timestamp:** ${report.timestamp}`);
    lines.push(`- **Project:** \`${report.projectRoot}\``);
    lines.push(`- **Overall Result:** ${badge}`);
    lines.push('');

    // --- Summary stats table ---
    lines.push('## Summary');
    lines.push('');
    lines.push('| Metric | Value |');
    lines.push('|--------|-------|');
    lines.push(`| Total Issues | ${report.stats.totalIssues} |`);
    lines.push(`| Critical | ${report.stats.critical} |`);
    lines.push(`| Major | ${report.stats.major} |`);
    lines.push(`| Minor | ${report.stats.minor} |`);
    lines.push(`| Info | ${report.stats.info} |`);
    lines.push(`| Total Duration | ${this.formatDuration(report.stats.totalDuration)} |`);
    lines.push('');

    // --- Static phase ---
    if (report.static.included) {
      lines.push(this.renderPhaseSection(
        'Static Analysis',
        report.static.passed,
        report.static.duration,
        report.static.issues,
        [
          `Checks: ${report.static.checks}`,
        ],
      ));
    }

    // --- Runtime phase ---
    if (report.runtime.included) {
      lines.push(this.renderPhaseSection(
        'Runtime Verification',
        report.runtime.passed,
        report.runtime.duration,
        report.runtime.issues,
        [
          `Checks: ${report.runtime.checks}`,
        ],
      ));
    }

    // --- Business phase ---
    if (report.business.included) {
      lines.push(this.renderPhaseSection(
        'Business Verification',
        report.business.passed,
        report.business.duration,
        report.business.issues,
        [
          `Scenarios: ${report.business.scenariosPassed}/${report.business.scenarios} passed`,
        ],
      ));
    }

    // --- All issues grouped by severity ---
    const grouped = this.groupIssuesBySeverity([
      ...report.static.issues,
      ...report.runtime.issues,
      ...report.business.issues,
    ]);

    if (grouped.length > 0) {
      lines.push('## All Issues by Severity');
      lines.push('');

      for (const { severity, issues } of grouped) {
        const icon = this.severityIcon(severity);
        lines.push(`### ${icon} ${severity.charAt(0).toUpperCase() + severity.slice(1)} (${issues.length})`);
        lines.push('');

        for (const issue of issues) {
          lines.push(this.renderIssue(issue));
        }

        lines.push('');
      }
    } else {
      lines.push('## All Issues by Severity');
      lines.push('');
      lines.push('No issues found. All checks passed.');
      lines.push('');
    }

    // --- Footer / Recommendation ---
    lines.push('---');
    lines.push('');
    lines.push(this.buildRecommendation(report));
    lines.push('');

    return lines.join('\n');
  }

  /**
   * Save both JSON and Markdown report files to the given directory.
   * Returns the paths of the written files.
   */
  async saveReport(
    report: TestReport,
    outputDir: string,
  ): Promise<{ jsonPath: string; markdownPath: string }> {
    await mkdir(outputDir, { recursive: true });

    const timestamp = report.timestamp.replace(/[:.]/g, '-');
    const baseName = `test-report-${timestamp}`;
    const jsonPath = join(outputDir, `${baseName}.json`);
    const markdownPath = join(outputDir, `${baseName}.md`);

    await Promise.all([
      writeFile(jsonPath, this.toJSON(report), 'utf-8'),
      writeFile(markdownPath, this.toMarkdown(report), 'utf-8'),
    ]);

    return { jsonPath, markdownPath };
  }

  /**
   * Filter issues to those at or above the given severity level.
   * Defaults to returning all issues.
   */
  filterIssues(
    report: TestReport,
    minSeverity: 'critical' | 'major' | 'minor' | 'info' = 'info',
  ): TestIssue[] {
    const threshold = SEVERITY_ORDER[minSeverity] ?? SEVERITY_ORDER['info'];

    return [
      ...report.static.issues,
      ...report.runtime.issues,
      ...report.business.issues,
    ].filter((issue) => (SEVERITY_ORDER[issue.severity] ?? SEVERITY_ORDER['info']) <= threshold);
  }

  // -----------------------------------------------------------------------
  // Normalization: convert verifier results into TestIssue[]
  // -----------------------------------------------------------------------

  private normalizeStaticIssues(result: StaticVerificationResult): TestIssue[] {
    const issues: TestIssue[] = [];
    let counter = 0;

    for (const check of result.checks) {
      if (check.passed) continue;

      counter++;
      const id = `STATIC-${this.sanitizeForId(check.name)}-${String(counter).padStart(3, '0')}`;

      issues.push({
        id,
        phase: 'static',
        severity: check.severity,
        category: this.inferStaticCategory(check.name),
        module: 'static',
        file: check.file,
        line: check.line,
        description: check.error ?? check.output,
        suggestion: this.suggestStaticFix(check.name, check.severity),
        rawOutput: check.output,
      });
    }

    return issues;
  }

  private normalizeRuntimeIssues(result: RuntimeVerificationResult): TestIssue[] {
    const issues: TestIssue[] = [];
    let counter = 0;

    for (const check of result.checks) {
      if (check.passed) continue;

      counter++;
      const id = `RUNTIME-${this.sanitizeForId(check.name)}-${String(counter).padStart(3, '0')}`;

      issues.push({
        id,
        phase: 'runtime',
        severity: check.severity,
        category: this.inferRuntimeCategory(check.name),
        module: 'runtime',
        description: check.error ?? check.output,
        suggestion: this.suggestRuntimeFix(check.name, check.severity),
        rawOutput: check.output,
      });
    }

    return issues;
  }

  private normalizeBusinessIssues(result: BusinessVerificationResult): TestIssue[] {
    const issues: TestIssue[] = [];
    let counter = 0;

    for (const scenario of result.scenarios) {
      if (scenario.passed) continue;

      counter++;
      const id = `BIZ-${this.sanitizeForId(scenario.name)}-${String(counter).padStart(3, '0')}`;

      // Collect failed step descriptions for context
      const failedSteps = scenario.steps
        .filter((s) => !s.passed)
        .map((s) => s.description ?? s.action);

      issues.push({
        id,
        phase: 'business',
        severity: this.scenarioPriorityToSeverity(scenario.priority),
        category: 'scenario',
        module: 'business',
        description: scenario.error ?? `Scenario "${scenario.name}" failed at step(s): ${failedSteps.join(', ')}`,
        suggestion: this.suggestBusinessFix(scenario.name, scenario.steps),
        rawOutput: failedSteps.join('\n'),
      });
    }

    return issues;
  }

  // -----------------------------------------------------------------------
  // Markdown rendering helpers
  // -----------------------------------------------------------------------

  private renderPhaseSection(
    title: string,
    passed: boolean,
    duration: number,
    issues: TestIssue[],
    extraLines: string[],
  ): string {
    const lines: string[] = [];

    lines.push(`## ${title}`);
    lines.push('');
    lines.push(`**Status:** ${passed ? 'PASS' : 'FAIL'} | **Duration:** ${this.formatDuration(duration)}`);
    if (extraLines.length > 0) {
      lines.push(` | ${extraLines.join(' | ')}`);
    }
    lines.push('');

    if (issues.length === 0) {
      lines.push('No issues found.');
      lines.push('');
    } else {
      // Group issues by severity within this phase
      const grouped = this.groupIssuesBySeverity(issues);

      for (const { severity, issues: sevIssues } of grouped) {
        const icon = this.severityIcon(severity);
        lines.push(`### ${icon} ${severity.charAt(0).toUpperCase() + severity.slice(1)} (${sevIssues.length})`);
        lines.push('');

        for (const issue of sevIssues) {
          lines.push(this.renderIssue(issue));
        }

        lines.push('');
      }
    }

    return lines.join('\n');
  }

  private renderIssue(issue: TestIssue): string {
    const lines: string[] = [];

    const location = issue.file
      ? issue.line != null
        ? `\`${issue.file}:${issue.line}\``
        : `\`${issue.file}\``
      : '';

    lines.push(`#### ${issue.id}`);
    lines.push('');

    if (location) {
      lines.push(`- **Location:** ${location}`);
    }
    lines.push(`- **Severity:** ${issue.severity}`);
    lines.push(`- **Category:** ${issue.category}`);
    if (issue.module !== 'static' && issue.module !== 'runtime' && issue.module !== 'business') {
      lines.push(`- **Module:** ${issue.module}`);
    }
    lines.push(`- **Description:** ${issue.description}`);
    if (issue.suggestion) {
      lines.push(`- **Suggestion:** ${issue.suggestion}`);
    }

    lines.push('');
    return lines.join('\n');
  }

  private groupIssuesBySeverity(
    issues: TestIssue[],
  ): { severity: 'critical' | 'major' | 'minor' | 'info'; issues: TestIssue[] }[] {
    const order: Array<'critical' | 'major' | 'minor' | 'info'> = ['critical', 'major', 'minor', 'info'];
    const result: { severity: 'critical' | 'major' | 'minor' | 'info'; issues: TestIssue[] }[] = [];

    for (const severity of order) {
      const filtered = issues.filter((i) => i.severity === severity);
      if (filtered.length > 0) {
        result.push({ severity, issues: filtered });
      }
    }

    return result;
  }

  // -----------------------------------------------------------------------
  // Summary & recommendation builders
  // -----------------------------------------------------------------------

  private buildSummary(
    overallResult: TestReport['overallResult'],
    staticResult: StaticVerificationResult | undefined,
    runtimeResult: RuntimeVerificationResult | undefined,
    businessResult: BusinessVerificationResult | undefined,
    stats: TestReport['stats'],
  ): string {
    const parts: string[] = [];

    parts.push(`Overall result: ${overallResult.toUpperCase()}`);
    parts.push(`Total issues: ${stats.totalIssues} (${stats.critical} critical, ${stats.major} major, ${stats.minor} minor, ${stats.info} info)`);
    parts.push(`Total duration: ${this.formatDuration(stats.totalDuration)}`);
    parts.push('');

    if (staticResult) {
      parts.push(`Static Analysis: ${staticResult.passed ? 'PASSED' : 'FAILED'} (${staticResult.checks.length} checks, ${this.formatDuration(staticResult.duration)})`);
    }
    if (runtimeResult) {
      parts.push(`Runtime Verification: ${runtimeResult.passed ? 'PASSED' : 'FAILED'} (${runtimeResult.checks.length} checks, ${this.formatDuration(runtimeResult.duration)})`);
    }
    if (businessResult) {
      const passed = businessResult.scenarios.filter((s) => s.passed).length;
      parts.push(`Business Verification: ${businessResult.passed ? 'PASSED' : 'FAILED'} (${passed}/${businessResult.scenarios.length} scenarios, ${this.formatDuration(businessResult.duration)})`);
    }

    return parts.join('\n');
  }

  private buildRecommendation(report: TestReport): string {
    const { stats, overallResult } = report;

    if (overallResult === 'pass') {
      return 'All verification layers passed with no critical or major issues. The project is ready for the next stage.';
    }

    const parts: string[] = [];

    if (stats.critical > 0) {
      parts.push(`- Fix ${stats.critical} critical issue${stats.critical > 1 ? 's' : ''} before proceeding. These are blocking problems that prevent the application from functioning correctly.`);
    }

    if (stats.major > 0) {
      parts.push(`- Address ${stats.major} major issue${stats.major > 1 ? 's' : ''}. These are significant problems that may cause incorrect behavior in production.`);
    }

    if (stats.minor > 0) {
      parts.push(`- Consider resolving ${stats.minor} minor issue${stats.minor > 1 ? 's' : ''} when convenient. These are non-blocking but should be tracked.`);
    }

    if (stats.info > 0) {
      parts.push(`- ${stats.info} informational note${stats.info > 1 ? 's' : ''} available for review.`);
    }

    if (overallResult === 'fail') {
      parts.push('');
      parts.push('**Recommendation:** Do not proceed to deployment until all critical issues are resolved.');
    } else if (overallResult === 'warn') {
      parts.push('');
      parts.push('**Recommendation:** Review and address major issues before deploying to production.');
    }

    return parts.join('\n');
  }

  // -----------------------------------------------------------------------
  // Suggestion helpers
  // -----------------------------------------------------------------------

  private inferStaticCategory(checkName: string): string {
    const lower = checkName.toLowerCase();
    if (lower.includes('typescript') || lower.includes('compilation') || lower.includes('tsc')) {
      return 'compilation';
    }
    if (lower.includes('eslint') || lower.includes('lint')) {
      return 'lint';
    }
    if (lower.includes('build')) {
      return 'build';
    }
    if (lower.includes('project detection')) {
      return 'configuration';
    }
    return 'static';
  }

  private inferRuntimeCategory(checkName: string): string {
    const lower = checkName.toLowerCase();
    if (lower.includes('startup') || lower.includes('start')) {
      return 'startup';
    }
    if (lower.includes('health')) {
      return 'health';
    }
    if (lower.includes('api')) {
      return 'api';
    }
    return 'runtime';
  }

  private scenarioPriorityToSeverity(priority: string): 'critical' | 'major' | 'minor' | 'info' {
    switch (priority) {
      case 'critical':
        return 'critical';
      case 'major':
        return 'major';
      case 'minor':
        return 'minor';
      default:
        return 'info';
    }
  }

  private suggestStaticFix(checkName: string, _severity: string): string {
    const lower = checkName.toLowerCase();

    if (lower.includes('typescript') || lower.includes('compilation') || lower.includes('tsc')) {
      return 'Review TypeScript errors and fix type mismatches, missing imports, or syntax errors.';
    }
    if (lower.includes('eslint') || lower.includes('lint')) {
      return 'Run eslint with --fix to auto-resolve fixable lint errors, then address remaining issues manually.';
    }
    if (lower.includes('build')) {
      return 'Check the build output for detailed error messages. Common causes include missing dependencies or incorrect configuration.';
    }
    if (lower.includes('project detection')) {
      return 'Ensure package.json exists and is valid. Verify that required dependencies are installed.';
    }

    return `Investigate the ${checkName} failure and address the reported errors.`;
  }

  private suggestRuntimeFix(checkName: string, _severity: string): string {
    const lower = checkName.toLowerCase();

    if (lower.includes('startup')) {
      return 'Check server logs for startup errors. Verify that all environment variables and configuration files are correct.';
    }
    if (lower.includes('health')) {
      return 'Ensure the server is running and listening on the expected port. Check for port conflicts or missing route handlers.';
    }
    if (lower.includes('api')) {
      return 'Verify that API endpoints are correctly implemented and return the expected status codes. Check route definitions and middleware.';
    }

    return `Investigate the ${checkName} failure and review the server logs for details.`;
  }

  private suggestBusinessFix(
    _scenarioName: string,
    steps: Array<{ action: string; passed: boolean; description?: string; error?: string }>,
  ): string {
    const failedSteps = steps.filter((s) => !s.passed);

    if (failedSteps.length === 0) return '';

    const descriptions = failedSteps.map((s) => {
      const desc = s.description ?? s.action;
      return s.error ? `${desc} (${s.error})` : desc;
    });

    return `Review the failed step${failedSteps.length > 1 ? 's' : ''}: ${descriptions.join('; ')}. Ensure the UI elements exist and the expected behavior is correctly implemented.`;
  }

  // -----------------------------------------------------------------------
  // Utility helpers
  // -----------------------------------------------------------------------

  private sanitizeForId(name: string): string {
    return name
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 12);
  }

  private formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.round((ms % 60_000) / 1000);
    return `${minutes}m ${seconds}s`;
  }

  private resultBadge(result: 'pass' | 'fail' | 'warn'): string {
    switch (result) {
      case 'pass':
        return 'PASS';
      case 'fail':
        return 'FAIL';
      case 'warn':
        return 'WARN';
    }
  }

  private severityIcon(severity: string): string {
    switch (severity) {
      case 'critical':
        return 'CRITICAL';
      case 'major':
        return 'MAJOR';
      case 'minor':
        return 'MINOR';
      case 'info':
        return 'INFO';
      default:
        return 'UNKNOWN';
    }
  }
}

/**
 * agents/reviewer.ts
 *
 * Reviewer Agent -- the code quality gatekeeper.
 *
 * Responsibilities:
 *   - Reviews code changes after development
 *   - Checks code quality, security, performance
 *   - Validates adherence to project coding standards (from ai-dev.json)
 *   - Generates review report with issues and suggestions
 *   - Approves or requests changes via MessageBus
 *
 * Extends AgentBase from core/agent-base.ts.
 * Communicates exclusively through MessageBus.
 */

import { randomUUID } from 'node:crypto';
import type { MessageBus, Message, MessageType } from '../core/message-bus.js';
import type { AgentConfig, TaskDescriptor, TaskResult } from '../core/agent-base.js';
import { AgentBase } from '../core/agent-base.js';
import type { Logger } from '../core/logger.js';
import type { LLMClient } from '../tools/llm-client.js';
import type { FileSystemTool } from '../tools/file-system.js';
import type { GitClient } from '../tools/git-client.js';
import { REVIEWER_SYSTEM_PROMPT } from '../prompts/system-prompts.js';

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Configuration for the Reviewer Agent.
 */
export interface ReviewerConfig {
  id?: string;
  name?: string;
  systemPrompt?: string;
  maxIterations?: number;
  temperature?: number;
  maxTokens?: number;
  autoApproveThreshold?: number;
}

/**
 * Severity levels for review issues.
 */
type IssueSeverity = 'critical' | 'major' | 'minor' | 'suggestion';

/**
 * Category of a review issue.
 */
type IssueCategory = 'quality' | 'security' | 'performance' | 'standards';

/**
 * A single issue found during code review.
 */
export interface ReviewIssue {
  severity: IssueSeverity;
  category: IssueCategory;
  file: string;
  line?: number;
  description: string;
  suggestion: string;
}

/**
 * Structured review report produced by this agent.
 */
export interface ReviewReport {
  approved: boolean;
  summary: string;
  score: number;
  issues: ReviewIssue[];
  positives: string[];
  filesReviewed: string[];
  reviewDuration: number;
}

/**
 * Coding standards loaded from ai-dev.json.
 */
interface CodingStandards {
  indentStyle?: string;
  indentSize?: number;
  semi?: boolean;
  singleQuotes?: boolean;
  trailingComma?: string;
  maxLineLength?: number;
  namingConvention?: string;
}

// ─── Reviewer Agent ─────────────────────────────────────────────────────────

export class ReviewerAgent extends AgentBase {
  private llm: LLMClient;
  private fs: FileSystemTool;
  private git: GitClient;
  private autoApproveThreshold: number;

  constructor(
    config: ReviewerConfig,
    messageBus: MessageBus,
    llm: LLMClient,
    fs: FileSystemTool,
    git: GitClient,
    logger?: Logger,
  ) {
    const agentConfig: AgentConfig = {
      id: config.id,
      name: config.name ?? 'reviewer',
      systemPrompt: config.systemPrompt ?? REVIEWER_SYSTEM_PROMPT,
      maxIterations: config.maxIterations ?? 15,
      temperature: config.temperature ?? 0.3,
      maxTokens: config.maxTokens ?? 16384,
    };

    super(agentConfig, messageBus, logger);

    this.llm = llm;
    this.fs = fs;
    this.git = git;
    this.autoApproveThreshold = config.autoApproveThreshold ?? 70;
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  protected getSubscribedMessageTypes(): MessageType[] {
    return ['task_assigned'];
  }

  protected async handleMessage(message: Message): Promise<void> {
    if (message.type === 'task_assigned' && message.to === this.id) {
      await this.handleTaskAssignment(message);
    }
  }

  // ─── Main Entry Point ──────────────────────────────────────────────────

  /**
   * Execute a code review task.
   */
  async execute(task: TaskDescriptor): Promise<TaskResult> {
    if (!this.isReady() && this.getStatus() !== 'busy') {
      return this.createFailureResult('Agent not initialized');
    }

    this.setStatus('busy');
    this.setActiveTask(task.id);

    // Clear history for independent context window
    this.clearHistory();

    this.addUserMessage(
      `[Task ${task.id}] ${task.type}: ${task.title}\n${task.description}`,
    );

    try {
      const result = await this.reviewCode(task);
      this.setStatus('ready');
      this.setActiveTask(null);
      return result;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.error('Review task failed', { taskId: task.id, error: errorMessage });
      this.setStatus('ready');
      this.setActiveTask(null);
      return this.createFailureResult(errorMessage);
    }
  }

  // ─── Task Assignment Handler ───────────────────────────────────────────

  /**
   * Handle incoming task_assigned messages from the MessageBus.
   */
  private async handleTaskAssignment(message: Message): Promise<void> {
    const task = message.payload as TaskDescriptor;
    this.logger.info('Received review task assignment', {
      taskId: task.id,
      type: task.type,
      title: task.title,
    });

    const result = await this.execute(task);

    if (result.success) {
      this.respond(message, 'task_completed', result);
    } else {
      this.respond(message, 'task_failed', {
        error: result.error,
        taskId: task.id,
      });
    }
  }

  // ─── Code Review ───────────────────────────────────────────────────────

  /**
   * Review code changes: read files, analyze with LLM, run static checks,
   * generate structured report, and publish via MessageBus.
   */
  private async reviewCode(task: TaskDescriptor): Promise<TaskResult> {
    const startTime = Date.now();
    this.logger.info('Starting code review', { title: task.title });

    const payload = task.payload ?? {};
    const filesToReview = payload.filesToReview as string[] | undefined;

    // Step 1: Determine which files to review
    const reviewFiles = await this.resolveFilesToReview(filesToReview);
    if (reviewFiles.length === 0) {
      return this.createFailureResult('No files to review');
    }

    this.logger.info('Files to review', { count: reviewFiles.length, files: reviewFiles });

    // Step 2: Load coding standards
    const codingStandards = await this.loadCodingStandards();

    // Step 3: Read file contents
    const fileContents = await this.readFileContents(reviewFiles);

    // Step 4: Perform LLM-based deep review
    const llmReview = await this.performLLMReview(fileContents, codingStandards);

    // Step 5: Perform static analysis checks
    const staticIssues = this.performStaticAnalysis(fileContents, codingStandards);

    // Step 6: Merge issues (deduplicate)
    const allIssues = this.mergeIssues(llmReview.issues, staticIssues);

    // Step 7: Calculate score and approval
    const score = this.calculateScore(allIssues);
    const approved = this.determineApproval(allIssues, score);

    // Step 8: Build review report
    const report: ReviewReport = {
      approved,
      summary: llmReview.summary,
      score,
      issues: allIssues,
      positives: llmReview.positives,
      filesReviewed: reviewFiles,
      reviewDuration: Date.now() - startTime,
    };

    // Step 9: Publish review result via MessageBus
    this.publishReviewResult(report);

    // Step 10: Build log messages
    const logs: string[] = [
      `Reviewed ${reviewFiles.length} files in ${report.reviewDuration}ms`,
      `Score: ${score}/100`,
      approved ? 'APPROVED' : 'CHANGES REQUESTED',
      `${allIssues.length} issues found`,
      ...allIssues.map(i => `  [${i.severity.toUpperCase()}] ${i.category}: ${i.file}${i.line ? `:${i.line}` : ''} - ${i.description}`),
    ];

    this.addAssistantMessage(
      `Review complete: ${approved ? 'APPROVED' : 'CHANGES REQUESTED'} (score: ${score}/100, ${allIssues.length} issues)`,
    );

    return this.createSuccessResult(
      {
        reviewReport: report,
        approved,
        score,
        issueCount: allIssues.length,
      },
      [],
      logs,
    );
  }

  // ─── File Resolution ───────────────────────────────────────────────────

  /**
   * Resolve which files to review. If not specified, review all source files
   * changed since the last commit.
   */
  private async resolveFilesToReview(specifiedFiles?: string[]): Promise<string[]> {
    if (specifiedFiles && specifiedFiles.length > 0) {
      return specifiedFiles.filter(f => !f.includes('node_modules') && !f.includes('dist/'));
    }

    try {
      const status = await this.git.status();
      const changedFiles = [
        ...status.modified,
        ...status.staged,
        ...status.notAdded,
      ];
      if (changedFiles.length > 0) {
        return changedFiles.filter(f => !f.includes('node_modules') && !f.includes('dist/'));
      }
    } catch {
      // Git status not available
    }

    // Fall back to all source files
    try {
      const allFiles = await this.fs.listAllFiles();
      return allFiles.filter(f => {
        const isCodeFile = /\.(ts|js|tsx|jsx)$/.test(f);
        const isNotTest = !f.includes('.test.') && !f.includes('.spec.');
        const isNotConfig = !f.includes('node_modules') &&
          !f.includes('dist/') &&
          !f.includes('.config.') &&
          f !== 'package.json';
        return isCodeFile && isNotTest && isNotConfig;
      });
    } catch {
      return [];
    }
  }

  // ─── File Reading ──────────────────────────────────────────────────────

  /**
   * Read the contents of multiple files.
   */
  private async readFileContents(filePaths: string[]): Promise<Map<string, string>> {
    const contents = new Map<string, string>();

    for (const filePath of filePaths) {
      try {
        const content = await this.fs.readFile(filePath);
        contents.set(filePath, content);
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        this.logger.warn('Failed to read file for review', { file: filePath, error: errorMessage });
      }
    }

    return contents;
  }

  // ─── Coding Standards ──────────────────────────────────────────────────

  /**
   * Load coding standards from ai-dev.json.
   */
  private async loadCodingStandards(): Promise<CodingStandards> {
    try {
      const configContent = await this.fs.readFile('ai-dev.json');
      const config = JSON.parse(configContent);
      return config.codingStandards ?? {};
    } catch {
      return {};
    }
  }

  // ─── LLM Review ────────────────────────────────────────────────────────

  /**
   * Perform deep code review using the LLM.
   */
  private async performLLMReview(
    fileContents: Map<string, string>,
    codingStandards: CodingStandards,
  ): Promise<{ summary: string; issues: ReviewIssue[]; positives: string[] }> {
    const filesText = Array.from(fileContents.entries())
      .map(([path, content]) => {
        const lines = content.split('\n').length;
        const preview = content.length > 2000 ? content.substring(0, 2000) + '\n... (truncated)' : content;
        return `### ${path} (${lines} lines)\n\`\`\`\n${preview}\n\`\`\``;
      })
      .join('\n\n');

    const standardsText = Object.keys(codingStandards).length > 0
      ? JSON.stringify(codingStandards, null, 2)
      : 'No specific coding standards configured';

    const prompt = `Review the following code files for quality, security, performance, and standards compliance.

## Files to Review
${filesText}

## Coding Standards
${standardsText}

## Review Checklist
For each file, check:

**Code Quality:**
- Naming: variables, functions, classes follow conventions
- Structure: functions are small (< 50 lines), single responsibility
- DRY: no duplicated code
- Comments: complex logic is explained
- Types: proper TypeScript types, no 'any' abuse
- Error handling: errors are caught and handled

**Security:**
- Input validation: all user inputs validated and sanitized
- Injection: no SQL injection, XSS, or command injection
- Authentication: auth checks where needed
- Secrets: no hardcoded API keys, passwords, or tokens
- Data exposure: sensitive data not logged or exposed in errors

**Performance:**
- Algorithms: appropriate time complexity
- Memory: no obvious memory leaks
- Async: proper use of async/await
- Caching: appropriate caching for expensive operations

**Standards Compliance:**
- Indentation: matches configured style
- Quotes: matches configured style
- Semicolons: matches configured style
- Naming convention: matches configured style
- Max line length: within limits

Respond in JSON format:
{
  "summary": "Overall assessment (2-3 sentences)",
  "issues": [{
    "severity": "critical|major|minor|suggestion",
    "category": "quality|security|performance|standards",
    "file": "file path",
    "line": line number or null,
    "description": "what the issue is",
    "suggestion": "how to fix it"
  }],
  "positives": ["thing done well 1", "thing done well 2"]
}`;

    const schema = {
      summary: 'string',
      issues: [{
        severity: 'string',
        category: 'string',
        file: 'string',
        line: 'number|null',
        description: 'string',
        suggestion: 'string',
      }],
      positives: ['string'],
    };

    try {
      const result = await this.llm.completeStructured<{
        summary: string;
        issues: ReviewIssue[];
        positives: string[];
      }>(prompt, schema);

      // Validate and normalize issues
      const validSeverities = new Set<IssueSeverity>(['critical', 'major', 'minor', 'suggestion']);
      const validCategories = new Set<IssueCategory>(['quality', 'security', 'performance', 'standards']);

      const normalizedIssues = (result.issues ?? []).map(issue => ({
        severity: validSeverities.has(issue.severity as IssueSeverity)
          ? issue.severity as IssueSeverity
          : 'minor' as IssueSeverity,
        category: validCategories.has(issue.category as IssueCategory)
          ? issue.category as IssueCategory
          : 'quality' as IssueCategory,
        file: issue.file,
        line: issue.line,
        description: issue.description,
        suggestion: issue.suggestion,
      }));

      return {
        summary: result.summary ?? 'Review completed',
        issues: normalizedIssues,
        positives: result.positives ?? [],
      };
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.error('LLM review failed', { error: errorMessage });

      return {
        summary: `Review analysis encountered an error: ${errorMessage}. Static analysis results only.`,
        issues: [],
        positives: [],
      };
    }
  }

  // ─── Static Analysis ───────────────────────────────────────────────────

  /**
   * Perform basic static analysis checks that don't require the LLM.
   */
  private performStaticAnalysis(
    fileContents: Map<string, string>,
    codingStandards: CodingStandards,
  ): ReviewIssue[] {
    const issues: ReviewIssue[] = [];

    for (const [filePath, content] of fileContents) {
      const lines = content.split('\n');

      // Check for hardcoded secrets
      const secretPatterns = [
        { pattern: /(?:api[_-]?key|apikey|secret|password|token)\s*[:=]\s*['"][^'"]{8,}['"]/i, desc: 'Possible hardcoded secret/credential' },
        { pattern: /sk-[a-zA-Z0-9]{20,}/, desc: 'Possible API key detected' },
        { pattern: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/, desc: 'Private key detected in source code' },
      ];

      for (const { pattern, desc } of secretPatterns) {
        const match = content.match(pattern);
        if (match) {
          const lineNum = content.substring(0, match.index!).split('\n').length;
          issues.push({
            severity: 'critical',
            category: 'security',
            file: filePath,
            line: lineNum,
            description: desc,
            suggestion: 'Move this secret to an environment variable or a secure configuration file. Never commit secrets to source control.',
          });
        }
      }

      // Check for console.log statements
      const consoleLogPattern = /console\.(log|warn|error|debug|info)\s*\(/g;
      let consoleMatch;
      while ((consoleMatch = consoleLogPattern.exec(content)) !== null) {
        const lineNum = content.substring(0, consoleMatch.index).split('\n').length;
        // Skip test files
        if (!filePath.includes('.test.') && !filePath.includes('.spec.')) {
          issues.push({
            severity: 'minor',
            category: 'quality',
            file: filePath,
            line: lineNum,
            description: `Console ${consoleMatch[1]} statement found`,
            suggestion: 'Remove console statements or replace with proper logging framework.',
          });
        }
      }

      // Check for TODO/FIXME/HACK comments
      const todoPattern = /(?:TODO|FIXME|HACK|XXX)\b/g;
      let todoMatch;
      while ((todoMatch = todoPattern.exec(content)) !== null) {
        const lineNum = content.substring(0, todoMatch.index).split('\n').length;
        issues.push({
          severity: 'minor',
          category: 'quality',
          file: filePath,
          line: lineNum,
          description: `${todoMatch[0]} comment found`,
          suggestion: 'Resolve the TODO/FIXME/HACK or create an issue to track it.',
        });
      }

      // Check for 'any' type usage in TypeScript
      if (/\.(ts|tsx)$/.test(filePath)) {
        const anyPattern = /:\s*any\b/g;
        let anyMatch;
        while ((anyMatch = anyPattern.exec(content)) !== null) {
          const lineNum = content.substring(0, anyMatch.index).split('\n').length;
          issues.push({
            severity: 'minor',
            category: 'quality',
            file: filePath,
            line: lineNum,
            description: 'TypeScript "any" type usage detected',
            suggestion: 'Replace "any" with a proper type definition for better type safety.',
          });
        }
      }

      // Check line length
      const maxLineLength = codingStandards.maxLineLength ?? 100;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].length > maxLineLength + 20) { // 20 char tolerance
          issues.push({
            severity: 'suggestion',
            category: 'standards',
            file: filePath,
            line: i + 1,
            description: `Line too long (${lines[i].length} chars, max ${maxLineLength})`,
            suggestion: 'Break the line into multiple lines for better readability.',
          });
        }
      }

      // Check for empty catch blocks
      const emptyCatchPattern = /catch\s*\([^)]*\)\s*\{\s*\}/g;
      let catchMatch;
      while ((catchMatch = emptyCatchPattern.exec(content)) !== null) {
        const lineNum = content.substring(0, catchMatch.index).split('\n').length;
        issues.push({
          severity: 'major',
          category: 'quality',
          file: filePath,
          line: lineNum,
          description: 'Empty catch block -- errors are silently swallowed',
          suggestion: 'Add error logging or handling inside the catch block, or re-throw the error.',
        });
      }
    }

    return issues;
  }

  // ─── Issue Merging ─────────────────────────────────────────────────────

  /**
   * Merge and deduplicate issues from LLM review and static analysis.
   */
  private mergeIssues(llmIssues: ReviewIssue[], staticIssues: ReviewIssue[]): ReviewIssue[] {
    const allIssues = [...llmIssues, ...staticIssues];

    // Deduplicate: same file + same description
    const seen = new Set<string>();
    return allIssues.filter(issue => {
      const key = `${issue.file}:${issue.description.substring(0, 50)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Sort by severity (critical first)
    const severityOrder: Record<IssueSeverity, number> = {
      critical: 0,
      major: 1,
      minor: 2,
      suggestion: 3,
    };

    allIssues.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

    return allIssues;
  }

  // ─── Scoring ───────────────────────────────────────────────────────────

  /**
   * Calculate a quality score (0-100) based on issues found.
   */
  private calculateScore(issues: ReviewIssue[]): number {
    let score = 100;

    for (const issue of issues) {
      switch (issue.severity) {
        case 'critical':
          score -= 25;
          break;
        case 'major':
          score -= 10;
          break;
        case 'minor':
          score -= 3;
          break;
        case 'suggestion':
          score -= 1;
          break;
      }
    }

    return Math.max(0, Math.min(100, score));
  }

  /**
   * Determine whether the code should be approved.
   * Criteria: no critical issues, no more than 2 major issues, score >= threshold.
   */
  private determineApproval(issues: ReviewIssue[], score: number): boolean {
    const criticalCount = issues.filter(i => i.severity === 'critical').length;
    const majorCount = issues.filter(i => i.severity === 'major').length;

    if (criticalCount > 0) return false;
    if (majorCount > 2) return false;
    if (score < this.autoApproveThreshold) return false;

    return true;
  }

  // ─── Message Bus Publishing ────────────────────────────────────────────

  /**
   * Publish the review result via MessageBus.
   */
  private publishReviewResult(report: ReviewReport): void {
    this.publish('review_result', '*', report, this.getActiveTaskId() ?? undefined);
    this.logger.info('Published review_result', {
      approved: report.approved,
      score: report.score,
      issueCount: report.issues.length,
    });
  }
}

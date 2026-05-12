/**
 * agents/developer.ts
 *
 * Developer Agent -- the code-writing specialist.
 *
 * Responsibilities:
 *   - Receives task assignments via MessageBus
 *   - Reads project context (existing files, architecture docs)
 *   - Generates code using DeepSeek API (LLMClient)
 *   - Writes files using FileSystemTool
 *   - Supports incremental development (modify existing files)
 *   - Fixes bugs when receiving test_result messages with failures
 *   - Commits changes via GitClient
 *   - Reports completion via MessageBus
 *
 * Extends AgentBase from core/agent-base.ts.
 * Independent context window -- only sees messages relevant to its current task.
 * Can delegate to sub-agents for specialized tasks.
 */

import { randomUUID } from 'node:crypto';
import type { MessageBus, Message, MessageType } from '../core/message-bus.js';
import type { AgentConfig, TaskDescriptor, TaskResult } from '../core/agent-base.js';
import { AgentBase } from '../core/agent-base.js';
import type { Logger } from '../core/logger.js';
import type { LLMClient } from '../tools/llm-client.js';
import type { FileSystemTool } from '../tools/file-system.js';
import type { GitClient } from '../tools/git-client.js';
import type {
  CodeFile,
  PRDDocument,
  TechStack,
  AcceptanceCriterion,
  TestResult as TypesTestResult,
  TestFailure,
} from '../types/index.js';
import { DEVELOPER_SYSTEM_PROMPT } from '../prompts/system-prompts.js';

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Configuration for the Developer Agent.
 */
export interface DeveloperConfig {
  id?: string;
  name?: string;
  systemPrompt?: string;
  maxIterations?: number;
  temperature?: number;
  maxTokens?: number;
  techStack?: {
    frontend?: string;
    backend?: string;
    language?: string;
    database?: string;
  };
  codingStyle?: string;
}

/**
 * Result of a code generation operation.
 */
interface CodeGenerationResult {
  files: CodeFile[];
  explanation: string;
}

/**
 * Context gathered from the project for code generation.
 */
interface ProjectContext {
  projectStructure: string;
  existingFiles: CodeFile[];
  prd: PRDDocument | null;
  architecture: string | null;
  techStack: TechStack | null;
  acceptanceCriteria: AcceptanceCriterion[];
  codingStandards: string;
}

// ─── File extension to language mapping ──────────────────────────────────────

const LANGUAGE_MAP: Record<string, string> = {
  js: 'javascript',
  ts: 'typescript',
  jsx: 'jsx',
  tsx: 'tsx',
  html: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  py: 'python',
  java: 'java',
  go: 'go',
  rs: 'rust',
  vue: 'vue',
  svelte: 'svelte',
  md: 'markdown',
  sql: 'sql',
  graphql: 'graphql',
  sh: 'bash',
  bash: 'bash',
};

const CODE_EXTENSIONS = new Set(Object.keys(LANGUAGE_MAP));

// ─── Developer Agent ─────────────────────────────────────────────────────────

export class DeveloperAgent extends AgentBase {
  private llm: LLMClient;
  private fs: FileSystemTool;
  private git: GitClient;
  private techStack: DeveloperConfig['techStack'];
  private codingStyle: string;

  constructor(
    config: DeveloperConfig,
    messageBus: MessageBus,
    llm: LLMClient,
    fs: FileSystemTool,
    git: GitClient,
    logger?: Logger,
  ) {
    const agentConfig: AgentConfig = {
      id: config.id,
      name: config.name ?? 'developer',
      systemPrompt: config.systemPrompt ?? DEVELOPER_SYSTEM_PROMPT,
      maxIterations: config.maxIterations ?? 20,
      temperature: config.temperature ?? 0.2,
      maxTokens: config.maxTokens ?? 16384,
    };

    super(agentConfig, messageBus, logger);

    this.llm = llm;
    this.fs = fs;
    this.git = git;
    this.techStack = config.techStack ?? {};
    this.codingStyle = config.codingStyle ?? 'modern, clean, well-documented';
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
   * Execute a development task. Clears history for a fresh context window,
   * gathers project context, generates code, writes files, and commits.
   */
  async execute(task: TaskDescriptor): Promise<TaskResult> {
    if (!this.isReady() && this.getStatus() !== 'busy') {
      return this.createFailureResult('Agent not initialized');
    }

    this.setStatus('busy');
    this.setActiveTask(task.id);

    // Clear history for a fresh context window (independent context)
    this.clearHistory();

    this.addUserMessage(
      `[Task ${task.id}] ${task.type}: ${task.title}\n${task.description}`,
    );

    try {
      let result: TaskResult;

      switch (task.type) {
        case 'develop_feature':
          result = await this.developFeature(task);
          break;
        case 'fix_bug':
          result = await this.fixBug(task);
          break;
        case 'design_architecture':
          result = await this.designArchitecture(task);
          break;
        default:
          result = await this.developFeature(task);
          break;
      }

      this.setStatus('ready');
      this.setActiveTask(null);
      return result;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.error('Task execution failed', { taskId: task.id, error: errorMessage });
      this.setStatus('ready');
      this.setActiveTask(null);
      return this.createFailureResult(errorMessage);
    }
  }

  // ─── Task Assignment Handler ───────────────────────────────────────────

  /**
   * Handle incoming task_assigned messages from the MessageBus.
   * Executes the task and responds with task_completed or task_failed.
   */
  private async handleTaskAssignment(message: Message): Promise<void> {
    const task = message.payload as TaskDescriptor;
    this.logger.info('Received task assignment', {
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

  // ─── Feature Development ───────────────────────────────────────────────

  /**
   * Develop a feature: gather context, generate code, write files, commit.
   */
  private async developFeature(task: TaskDescriptor): Promise<TaskResult> {
    this.logger.info('Developing feature', { title: task.title });

    // Step 1: Gather project context
    const context = await this.gatherProjectContext(task);

    // Step 2: Generate code
    const codeResult = await this.generateCode(task, context);
    if (!codeResult) {
      return this.createFailureResult('Code generation returned no results');
    }

    // Step 3: Write files
    const writtenFiles = await this.writeGeneratedFiles(codeResult.files);

    // Step 4: Commit changes
    await this.commitChanges(task.title, codeResult.explanation);

    // Step 5: Report completion
    this.addAssistantMessage(
      `Feature developed: ${task.title}. Created ${writtenFiles.length} files.`,
    );

    return this.createSuccessResult(
      {
        explanation: codeResult.explanation,
        filesCreated: writtenFiles,
        filesModified: codeResult.files
          .filter(f => f.path && await this.wasFileExisting(f.path).catch(() => false))
          .map(f => f.path),
      },
      writtenFiles,
      [
        `Developed feature: ${task.title}`,
        `Created/modified ${writtenFiles.length} files`,
        codeResult.explanation,
      ],
    );
  }

  // ─── Bug Fixing ────────────────────────────────────────────────────────

  /**
   * Fix a bug based on error context from test failures or bug reports.
   */
  private async fixBug(task: TaskDescriptor): Promise<TaskResult> {
    this.logger.info('Fixing bug', { title: task.title });

    const payload = task.payload ?? {};
    const failures = payload.failures as TestFailure[] | undefined;
    const testResult = payload.testResult as TypesTestResult | undefined;
    const reviewIssues = payload.reviewIssues as Array<{ description: string; suggestion: string; file: string }> | undefined;

    // Build error context
    let errorContext = task.description;

    if (failures && failures.length > 0) {
      errorContext = failures
        .map(f => `Test: ${f.testName}\nError: ${f.error}\nFile: ${f.file ?? 'unknown'}\nStack: ${f.stackTrace ?? 'N/A'}`)
        .join('\n\n---\n\n');
    } else if (reviewIssues && reviewIssues.length > 0) {
      errorContext = reviewIssues
        .map(i => `Issue: ${i.description}\nFile: ${i.file}\nSuggestion: ${i.suggestion}`)
        .join('\n\n---\n\n');
    } else if (testResult) {
      errorContext = `Test output:\n${testResult.logs}\n\nFailures:\n${testResult.failures.map(f => `${f.testName}: ${f.error}`).join('\n')}`;
    }

    // Identify files to fix
    const filesToFix = this.identifyFilesToFix(failures, reviewIssues);

    const fixedFiles: string[] = [];
    const logs: string[] = [];

    for (const filePath of filesToFix) {
      try {
        const originalCode = await this.fs.readFile(filePath);
        const fixedCode = await this.llm.fixCode(
          originalCode,
          errorContext,
          `Task: ${task.title}\nDescription: ${task.description}`,
        );

        await this.fs.writeFile(filePath, fixedCode);
        fixedFiles.push(filePath);
        logs.push(`Fixed file: ${filePath}`);
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        logs.push(`Failed to fix ${filePath}: ${errorMessage}`);
        this.logger.warn('Failed to fix file', { file: filePath, error: errorMessage });
      }
    }

    if (fixedFiles.length === 0) {
      // If no specific files identified, try to generate a fix based on the error context alone
      logs.push('No specific files identified for fix, attempting general fix');
      const context = await this.gatherProjectContext(task);
      const codeResult = await this.generateFixCode(task, context, errorContext);
      if (codeResult) {
        const written = await this.writeGeneratedFiles(codeResult.files);
        fixedFiles.push(...written);
        logs.push(`Generated fix in ${written.length} files`);
      }
    }

    // Commit fix
    const retryCount = (payload.retryCount as number) ?? 0;
    await this.commitFix(task.title, retryCount);

    this.addAssistantMessage(
      `Bug fixed: ${task.title}. Fixed ${fixedFiles.length} files.`,
    );

    return fixedFiles.length > 0
      ? this.createSuccessResult(
          {
            fixedFiles,
            fixDescription: `Fixed: ${task.title}`,
          },
          fixedFiles,
          logs,
        )
      : this.createFailureResult('Unable to fix the bug - no files were modified', logs);
  }

  // ─── Architecture Design ───────────────────────────────────────────────

  /**
   * Design the system architecture and generate config files.
   */
  private async designArchitecture(task: TaskDescriptor): Promise<TaskResult> {
    this.logger.info('Designing architecture', { title: task.title });

    const context = await this.gatherProjectContext(task);

    const prompt = `Design the system architecture for the following requirement.

## Task
Title: ${task.title}
Description: ${task.description}

## Tech Stack Preferences
${JSON.stringify(this.techStack, null, 2)}

## Current Project Structure
${context.projectStructure}

## Existing Code
${context.existingFiles.map(f => `### ${f.path}\n\`\`\`${f.language}\n${f.content?.substring(0, 500)}...\n\`\`\``).join('\n\n')}

Please provide:
1. High-level architecture description
2. Component breakdown with responsibilities
3. Data flow description
4. API design (if applicable)
5. Database schema (if applicable)
6. Directory structure
7. Configuration files needed (package.json, tsconfig.json, etc.)

Respond in JSON format:
{
  "architectureDoc": "Full architecture document in markdown",
  "configFiles": [{ "path": "string", "content": "string", "language": "string" }],
  "directoryStructure": ["list of directories to create"],
  "explanation": "Brief explanation of design decisions"
}`;

    const schema = {
      architectureDoc: 'string',
      configFiles: [{ path: 'string', content: 'string', language: 'string' }],
      directoryStructure: ['string'],
      explanation: 'string',
    };

    let result: {
      architectureDoc: string;
      configFiles: CodeFile[];
      directoryStructure: string[];
      explanation: string;
    };

    try {
      result = await this.llm.completeStructured<typeof result>(prompt, schema);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.error('Architecture design failed', { error: errorMessage });
      return this.createFailureResult(`Architecture design failed: ${errorMessage}`);
    }

    const artifacts: string[] = [];

    // Create directories
    if (result.directoryStructure && result.directoryStructure.length > 0) {
      for (const dir of result.directoryStructure) {
        try {
          await this.fs.createDirectory(dir);
        } catch (err: unknown) {
          this.logger.warn('Failed to create directory', { dir, error: err instanceof Error ? err.message : String(err) });
        }
      }
    }

    // Write architecture document
    try {
      await this.fs.createDirectory('docs');
      await this.fs.writeFile('docs/ARCHITECTURE.md', result.architectureDoc);
      artifacts.push('docs/ARCHITECTURE.md');
    } catch (err: unknown) {
      this.logger.warn('Failed to write architecture doc', { error: err instanceof Error ? err.message : String(err) });
    }

    // Write config files
    const writtenConfigFiles = await this.writeGeneratedFiles(result.configFiles);
    artifacts.push(...writtenConfigFiles);

    // Commit
    await this.commitChanges('Design Architecture', result.explanation);

    this.addAssistantMessage(
      `Architecture designed: ${task.title}. Created ${artifacts.length} artifacts.`,
    );

    return this.createSuccessResult(
      {
        architectureDoc: 'docs/ARCHITECTURE.md',
        configFiles: writtenConfigFiles,
        explanation: result.explanation,
      },
      artifacts,
      [
        'Architecture designed',
        `Created ${writtenConfigFiles.length} config files`,
        result.explanation,
      ],
    );
  }

  // ─── Context Gathering ─────────────────────────────────────────────────

  /**
   * Gather comprehensive project context for code generation.
   */
  private async gatherProjectContext(task: TaskDescriptor): Promise<ProjectContext> {
    const context: ProjectContext = {
      projectStructure: '',
      existingFiles: [],
      prd: null,
      architecture: null,
      techStack: null,
      acceptanceCriteria: [],
      codingStandards: '',
    };

    // Get project structure
    try {
      context.projectStructure = await this.fs.getProjectStructure();
    } catch (err: unknown) {
      this.logger.warn('Failed to get project structure', { error: err instanceof Error ? err.message : String(err) });
      context.projectStructure = 'Unable to read project structure';
    }

    // Get existing code files
    try {
      const allFiles = await this.fs.listAllFiles();
      const codeFilePaths = allFiles.filter(f => this.isCodeFile(f));

      for (const filePath of codeFilePaths.slice(0, 20)) {
        try {
          const content = await this.fs.readFile(filePath);
          context.existingFiles.push({
            path: filePath,
            content,
            language: this.getLanguageFromPath(filePath),
          });
        } catch {
          // Skip unreadable files
        }
      }
    } catch (err: unknown) {
      this.logger.warn('Failed to list project files', { error: err instanceof Error ? err.message : String(err) });
    }

    // Read PRD
    try {
      const prdContent = await this.fs.readFile('docs/PRD.md');
      context.prd = this.parsePRDFromMarkdown(prdContent);
    } catch {
      // PRD not available, check task payload
      const payloadPrd = task.payload?.prd as PRDDocument | undefined;
      if (payloadPrd) {
        context.prd = payloadPrd;
      }
    }

    // Read architecture doc
    try {
      context.architecture = await this.fs.readFile('docs/ARCHITECTURE.md');
    } catch {
      // Architecture doc not available
    }

    // Extract tech stack from PRD or config
    context.techStack = context.prd?.techStack ?? {
      frontend: this.techStack.frontend,
      backend: this.techStack.backend,
      database: this.techStack.database,
    };

    // Extract acceptance criteria
    if (context.prd?.acceptanceCriteria) {
      context.acceptanceCriteria = context.prd.acceptanceCriteria;
    } else {
      const payloadAC = task.payload?.acceptanceCriteria as AcceptanceCriterion[] | undefined;
      if (payloadAC) {
        context.acceptanceCriteria = payloadAC;
      }
    }

    // Read coding standards from ai-dev.json
    try {
      const configContent = await this.fs.readFile('ai-dev.json');
      const config = JSON.parse(configContent);
      if (config.codingStandards) {
        context.codingStandards = JSON.stringify(config.codingStandards, null, 2);
      }
    } catch {
      context.codingStandards = `Style: ${this.codingStyle}`;
    }

    return context;
  }

  // ─── Code Generation ───────────────────────────────────────────────────

  /**
   * Generate code for a feature using the LLM.
   */
  private async generateCode(
    task: TaskDescriptor,
    context: ProjectContext,
  ): Promise<CodeGenerationResult | null> {
    const existingCodeSummary = context.existingFiles
      .slice(0, 10)
      .map(f => `### ${f.path}\n\`\`\`${f.language}\n${f.content?.substring(0, 300)}...\n\`\`\``)
      .join('\n\n');

    const acceptanceCriteriaText = context.acceptanceCriteria.length > 0
      ? context.acceptanceCriteria.map(ac => `- [${ac.id}] Given ${ac.given}, When ${ac.when}, Then ${ac.then}`).join('\n')
      : 'No specific acceptance criteria provided';

    const prompt = `Implement the following feature.

## Task
Title: ${task.title}
Description: ${task.description}

## Project Context
${context.projectStructure}

## Existing Code
${existingCodeSummary || 'No existing code files found'}

## Architecture
${context.architecture ?? 'No architecture document available'}

## Tech Stack
${JSON.stringify(context.techStack, null, 2)}

## Acceptance Criteria
${acceptanceCriteriaText}

## Coding Standards
${context.codingStandards}

## Requirements
1. Write complete, production-ready code
2. Follow the project's coding standards exactly
3. Include comprehensive error handling
4. Add JSDoc/TSDoc comments for public APIs
5. Handle edge cases (null, undefined, empty inputs)
6. Use proper TypeScript types
7. Ensure the code is self-contained and importable
8. Do NOT include TODO/FIXME/HACK comments

For each file, provide:
- path: relative file path
- content: complete file content
- language: programming language

Respond in JSON format:
{
  "files": [{ "path": "string", "content": "string", "language": "string" }],
  "explanation": "Brief explanation of what was implemented and why"
}`;

    const schema = {
      files: [{ path: 'string', content: 'string', language: 'string' }],
      explanation: 'string',
    };

    try {
      const result = await this.llm.completeStructured<CodeGenerationResult>(prompt, schema);
      return result;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.error('Code generation failed', { error: errorMessage });

      // Retry with a simpler prompt
      return this.retryCodeGeneration(task, context);
    }
  }

  /**
   * Retry code generation with a simplified prompt.
   */
  private async retryCodeGeneration(
    task: TaskDescriptor,
    context: ProjectContext,
  ): Promise<CodeGenerationResult | null> {
    this.logger.info('Retrying code generation with simplified prompt');

    const simplePrompt = `Write code for: ${task.title}

${task.description}

Tech stack: ${JSON.stringify(context.techStack)}

Provide the code files as JSON:
{ "files": [{ "path": "string", "content": "string", "language": "string" }], "explanation": "string" }`;

    try {
      const result = await this.llm.completeStructured<CodeGenerationResult>(simplePrompt, {
        files: [{ path: 'string', content: 'string', language: 'string' }],
        explanation: 'string',
      });
      return result;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.error('Retry code generation also failed', { error: errorMessage });
      return null;
    }
  }

  /**
   * Generate fix code based on error context.
   */
  private async generateFixCode(
    task: TaskDescriptor,
    context: ProjectContext,
    errorContext: string,
  ): Promise<CodeGenerationResult | null> {
    const prompt = `Fix the following issues in the project.

## Task
Title: ${task.title}
Description: ${task.description}

## Issues to Fix
${errorContext}

## Current Project Files
${context.existingFiles.map(f => `### ${f.path}\n\`\`\`${f.language}\n${f.content?.substring(0, 500)}\n\`\`\``).join('\n\n')}

## Tech Stack
${JSON.stringify(context.techStack, null, 2)}

Provide the corrected files as JSON:
{ "files": [{ "path": "string", "content": "string", "language": "string" }], "explanation": "string" }

Only include files that need to be modified.`;

    try {
      const result = await this.llm.completeStructured<CodeGenerationResult>(prompt, {
        files: [{ path: 'string', content: 'string', language: 'string' }],
        explanation: 'string',
      });
      return result;
    } catch (err: unknown) {
      this.logger.error('Fix code generation failed', { error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  // ─── File Operations ───────────────────────────────────────────────────

  /**
   * Write generated code files to disk.
   */
  private async writeGeneratedFiles(files: CodeFile[]): Promise<string[]> {
    const writtenFiles: string[] = [];

    for (const file of files) {
      if (!file.path || !file.content) {
        this.logger.warn('Skipping file with missing path or content');
        continue;
      }

      try {
        await this.fs.writeFile(file.path, file.content);
        writtenFiles.push(file.path);
        this.logger.debug('Wrote file', { path: file.path });
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        this.logger.error('Failed to write file', { path: file.path, error: errorMessage });
      }
    }

    return writtenFiles;
  }

  /**
   * Check if a file already existed before this task.
   */
  private async wasFileExisting(filePath: string): Promise<boolean> {
    return this.fs.exists(filePath);
  }

  // ─── Git Operations ────────────────────────────────────────────────────

  /**
   * Commit changes with a feat: prefix.
   */
  private async commitChanges(taskTitle: string, details?: string): Promise<void> {
    try {
      await this.git.saveTaskCompletion(taskTitle, details);
    } catch (err: unknown) {
      this.logger.warn('Failed to commit changes', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Commit a bug fix with a fix: prefix.
   */
  private async commitFix(issue: string, attempt: number): Promise<void> {
    try {
      await this.git.saveFix(issue, attempt);
    } catch (err: unknown) {
      this.logger.warn('Failed to commit fix', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  /**
   * Identify which files need to be fixed based on test failures or review issues.
   */
  private identifyFilesToFix(
    failures?: TestFailure[],
    reviewIssues?: Array<{ description: string; suggestion: string; file: string }>,
  ): string[] {
    const files = new Set<string>();

    if (failures) {
      for (const failure of failures) {
        // Extract file path from test name or error
        const fileMatch = failure.testName?.match(/(?:in|for|from)\s+([^\s]+\.\w+)/i);
        if (fileMatch) {
          files.add(fileMatch[1]);
        }

        // Extract file path from error message
        const errorFileMatch = failure.error?.match(/([^\s:]+\.\w+):\d+/);
        if (errorFileMatch) {
          files.add(errorFileMatch[1]);
        }

        // Extract file from stack trace
        if (failure.stackTrace) {
          const stackFiles = failure.stackTrace.match(/(?:at\s+)?(?:[^\s]+\s+\()?(\/?[^\s:]+\.\w+):\d+/g);
          if (stackFiles) {
            for (const sf of stackFiles) {
              const cleanPath = sf.replace(/^at\s+/, '').replace(/^\(/, '').replace(/\)$/, '').trim();
              if (cleanPath && !cleanPath.includes('node_modules')) {
                files.add(cleanPath);
              }
            }
          }
        }
      }
    }

    if (reviewIssues) {
      for (const issue of reviewIssues) {
        if (issue.file) {
          files.add(issue.file);
        }
      }
    }

    return Array.from(files).filter(f => !f.includes('node_modules'));
  }

  /**
   * Check if a file path has a code extension.
   */
  private isCodeFile(filePath: string): boolean {
    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
    return CODE_EXTENSIONS.has(ext);
  }

  /**
   * Get the programming language from a file path.
   */
  private getLanguageFromPath(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
    return LANGUAGE_MAP[ext] ?? ext;
  }

  /**
   * Parse a PRD from markdown content (basic extraction).
   */
  private parsePRDFromMarkdown(markdown: string): PRDDocument | null {
    try {
      const titleMatch = markdown.match(/^#\s+(.+)$/m);
      const title = titleMatch?.[1]?.trim() ?? 'Untitled Project';

      const descriptionMatch = markdown.match(/##\s+Description\s*\n([\s\S]*?)(?=\n##\s|$)/);
      const description = descriptionMatch?.[1]?.trim() ?? '';

      const features: PRDDocument['features'] = [];
      const featureRegex = /-\s+\*\*(.+?)\*\*\s*\((high|medium|low)\):\s*(.+)/g;
      let featureMatch;
      while ((featureMatch = featureRegex.exec(markdown)) !== null) {
        features.push({
          id: `feat-${features.length + 1}`,
          name: featureMatch[1].trim(),
          priority: featureMatch[2].trim() as 'high' | 'medium' | 'low',
          description: featureMatch[3].trim(),
        });
      }

      const techStack: TechStack = {};
      const frontendMatch = markdown.match(/Frontend:\s*(.+)/);
      if (frontendMatch) techStack.frontend = frontendMatch[1].trim();
      const backendMatch = markdown.match(/Backend:\s*(.+)/);
      if (backendMatch) techStack.backend = backendMatch[1].trim();
      const dbMatch = markdown.match(/Database:\s*(.+)/);
      if (dbMatch) techStack.database = dbMatch[1].trim();

      const acceptanceCriteria: AcceptanceCriterion[] = [];
      const acRegex = /###\s*(\S+)\s*\n-\s+\*\*Given\*\*:\s*(.+?)\n-\s+\*\*When\*\*:\s*(.+?)\n-\s+\*\*Then\*\*:\s*(.+)/g;
      let acMatch;
      while ((acMatch = acRegex.exec(markdown)) !== null) {
        acceptanceCriteria.push({
          id: acMatch[1].trim(),
          given: acMatch[2].trim(),
          when: acMatch[3].trim(),
          then: acMatch[4].trim(),
          featureId: features.length > 0 ? features[0].id : '',
        });
      }

      return { title, description, features, techStack, acceptanceCriteria };
    } catch {
      return null;
    }
  }

  // ─── Sub-agent Delegation ──────────────────────────────────────────────

  /**
   * Generate unit tests for a specific file by delegating to the Tester Agent.
   */
  async generateTestsForFile(filePath: string, codeContent: string): Promise<TaskResult> {
    const testTask: TaskDescriptor = {
      id: `gen-tests-${randomUUID()}`,
      type: 'write_tests',
      title: `Generate tests for ${filePath}`,
      description: `Generate comprehensive unit tests for the file at ${filePath}`,
      payload: {
        targetFiles: [filePath],
        codeContent,
      },
    };

    return this.delegateToSubAgent('tester', testTask, 120000);
  }
}

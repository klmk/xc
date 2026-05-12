import type { Sandbox } from '../tools/sandbox.js';
import type { FileSystemTool } from '../tools/file-system.js';
import type { LLMClient } from '../tools/llm-client.js';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export type ScenarioAction =
  | 'navigate'
  | 'click'
  | 'fill'
  | 'select'
  | 'wait'
  | 'assert_visible'
  | 'assert_text'
  | 'assert_url'
  | 'screenshot'
  | 'hover'
  | 'press_key'
  | 'scroll';

export type ScenarioPriority = 'critical' | 'major' | 'minor';

export interface ScenarioStep {
  action: ScenarioAction;
  selector?: string;
  value?: string;
  url?: string;
  expected?: string | number | boolean;
  timeout?: number;
  description?: string;
}

export interface BusinessScenario {
  name: string;
  description: string;
  priority: ScenarioPriority;
  steps: ScenarioStep[];
  expectedOutcome: string;
}

export interface BusinessVerifyConfig {
  baseUrl?: string;
  scenarios?: BusinessScenario[];
  headless?: boolean;
  timeout?: number;
  screenshotDir?: string;
  specContent?: string;
}

export interface StepResult {
  action: string;
  description: string;
  passed: boolean;
  error?: string;
  duration: number;
  screenshot?: string;
}

export interface ScenarioResult {
  name: string;
  priority: ScenarioPriority;
  passed: boolean;
  steps: StepResult[];
  error?: string;
  screenshotPath?: string;
  duration: number;
}

export interface BusinessVerificationResult {
  passed: boolean;
  scenarios: ScenarioResult[];
  summary: string;
  duration: number;
  screenshots: string[];
}

// ---------------------------------------------------------------------------
// BusinessVerifier
// ---------------------------------------------------------------------------

export class BusinessVerifier {
  private projectRoot: string;
  private fs: FileSystemTool;
  private llm?: LLMClient;

  constructor(
    _sandbox: Sandbox,
    projectRoot: string,
    fs: FileSystemTool,
    llm?: LLMClient,
  ) {
    this.projectRoot = projectRoot;
    this.fs = fs;
    this.llm = llm;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  async verify(config?: BusinessVerifyConfig): Promise<BusinessVerificationResult> {
    const resolvedConfig: Required<Pick<BusinessVerifyConfig, 'baseUrl' | 'headless' | 'timeout' | 'screenshotDir'>> &
      Pick<BusinessVerifyConfig, 'scenarios' | 'specContent'> = {
      baseUrl: config?.baseUrl ?? 'http://localhost:3000',
      headless: config?.headless ?? true,
      timeout: config?.timeout ?? 60_000,
      screenshotDir: config?.screenshotDir ?? 'test-results/screenshots',
      scenarios: config?.scenarios,
      specContent: config?.specContent,
    };

    const overallStart = Date.now();
    const screenshots: string[] = [];

    // Ensure screenshot directory exists inside the project root
    const absoluteScreenshotDir = join(this.projectRoot, resolvedConfig.screenshotDir);
    try {
      await this.fs.createDirectory(resolvedConfig.screenshotDir);
    } catch {
      // Non-fatal -- screenshots are best-effort
    }

    // ------------------------------------------------------------------
    // 1. Resolve scenarios
    // ------------------------------------------------------------------
    let scenarios: BusinessScenario[] = [];

    if (resolvedConfig.scenarios && resolvedConfig.scenarios.length > 0) {
      scenarios = resolvedConfig.scenarios;
    } else if (this.llm && resolvedConfig.specContent) {
      try {
        scenarios = await this.generateScenariosFromSpec(resolvedConfig.specContent);
      } catch (err) {
        return this.buildResult(
          false,
          [],
          screenshots,
          overallStart,
          `Failed to generate scenarios from spec: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (scenarios.length === 0) {
      return this.buildResult(
        true,
        [],
        screenshots,
        overallStart,
        'No scenarios to execute. Provide scenarios or a specContent with an LLM client.',
      );
    }

    // ------------------------------------------------------------------
    // 2. Dynamically import Playwright
    // ------------------------------------------------------------------
    let chromium: typeof import('playwright')['chromium'];
    try {
      const playwright = await import('playwright');
      chromium = playwright.chromium;
    } catch {
      // Playwright is not installed -- business testing is optional
      return this.buildResult(
        true,
        [],
        screenshots,
        overallStart,
        'Playwright is not installed. Business verification is skipped (it is optional). Install Playwright with: npm install playwright',
      );
    }

    // ------------------------------------------------------------------
    // 3. Execute scenarios
    // ------------------------------------------------------------------
    const scenarioResults: ScenarioResult[] = [];
    let browser: import('playwright').Browser | null = null;

    try {
      browser = await chromium.launch({ headless: resolvedConfig.headless });

      for (const scenario of scenarios) {
        const result = await this.executeScenario(
          browser,
          scenario,
          resolvedConfig.baseUrl,
          resolvedConfig.timeout,
          absoluteScreenshotDir,
        );

        scenarioResults.push(result);

        if (result.screenshotPath) {
          screenshots.push(result.screenshotPath);
        }
        for (const step of result.steps) {
          if (step.screenshot) {
            screenshots.push(step.screenshot);
          }
        }
      }
    } finally {
      if (browser) {
        await browser.close();
      }
    }

    // ------------------------------------------------------------------
    // 4. Build summary
    // ------------------------------------------------------------------
    const anyCriticalFailed = scenarioResults.some(
      (r) => r.priority === 'critical' && !r.passed,
    );
    const passed = !anyCriticalFailed;
    const totalPassed = scenarioResults.filter((r) => r.passed).length;
    const totalFailed = scenarioResults.length - totalPassed;

    const summary = [
      `Business Verification: ${passed ? 'PASSED' : 'FAILED'}`,
      `Scenarios: ${scenarioResults.length} total, ${totalPassed} passed, ${totalFailed} failed`,
      ...scenarioResults.map((r) => {
        const icon = r.passed ? '[PASS]' : '[FAIL]';
        return `  ${icon} [${r.priority.toUpperCase()}] ${r.name} (${r.duration}ms)${r.error ? ' - ' + r.error : ''}`;
      }),
    ].join('\n');

    return this.buildResult(passed, scenarioResults, screenshots, overallStart, summary);
  }

  // -----------------------------------------------------------------------
  // Scenario generation from spec via LLM
  // -----------------------------------------------------------------------

  private async generateScenariosFromSpec(specContent: string): Promise<BusinessScenario[]> {
    if (!this.llm) {
      throw new Error('LLM client is required to generate scenarios from spec');
    }

    const prompt = `You are a QA engineer. Given the following product specification, generate up to 10 business-level test scenarios that verify the core user flows described in the spec.

Focus on:
- Critical user journeys (login, signup, main workflows)
- Key feature interactions
- NOT edge cases or error handling (those are unit-test territory)

Return a JSON array of BusinessScenario objects with this exact shape:
[
  {
    "name": "User Login Flow",
    "description": "Verify that a user can log in with valid credentials",
    "priority": "critical",
    "steps": [
      { "action": "navigate", "url": "/login", "description": "Go to login page" },
      { "action": "fill", "selector": "input[name='email']", "value": "test@example.com", "description": "Enter email" },
      { "action": "fill", "selector": "input[name='password']", "value": "password123", "description": "Enter password" },
      { "action": "click", "selector": "button[type='submit']", "description": "Click login button" },
      { "action": "assert_url", "expected": "/dashboard", "description": "Should redirect to dashboard" }
    ],
    "expectedOutcome": "User is redirected to the dashboard after successful login"
  }
]

Valid actions: navigate, click, fill, select, wait, assert_visible, assert_text, assert_url, screenshot, hover, press_key, scroll
Valid priorities: critical, major, minor

SPEC:
${specContent}

Respond with ONLY the JSON array, no other text.`;

    const response = await this.llm.complete(prompt);

    // Extract JSON from the response (handle markdown code fences)
    const jsonMatch =
      response.content.match(/```json\n?([\s\S]*?)```/) ||
      response.content.match(/```\n?([\s\S]*?)```/) ||
      [null, response.content];

    const jsonStr = jsonMatch[1]?.trim() ?? response.content.trim();
    const parsed = JSON.parse(jsonStr) as BusinessScenario[];

    if (!Array.isArray(parsed)) {
      throw new Error('LLM did not return a JSON array of scenarios');
    }

    // Cap at 10 scenarios
    return parsed.slice(0, 10);
  }

  // -----------------------------------------------------------------------
  // Execute a single scenario
  // -----------------------------------------------------------------------

  private async executeScenario(
    browser: import('playwright').Browser,
    scenario: BusinessScenario,
    baseUrl: string,
    timeout: number,
    screenshotDir: string,
  ): Promise<ScenarioResult> {
    const scenarioStart = Date.now();
    const stepResults: StepResult[] = [];
    let scenarioError: string | undefined;
    let scenarioScreenshotPath: string | undefined;

    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
    });

    let page: import('playwright').Page | null = null;

    try {
      page = await context.newPage();
      page.setDefaultTimeout(timeout);

      for (const step of scenario.steps) {
        const stepStart = Date.now();
        let stepScreenshot: string | undefined;

        try {
          await this.executeStep(page, step, baseUrl, screenshotDir, scenario.name);
          stepResults.push({
            action: step.action,
            description: step.description ?? step.action,
            passed: true,
            duration: Date.now() - stepStart,
            screenshot: stepScreenshot,
          });
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);

          // Take a screenshot on failure
          try {
            const failurePath = join(
              screenshotDir,
              `${this.sanitizeFileName(scenario.name)}-${step.action}-failure.png`,
            );
            await page.screenshot({ path: failurePath, fullPage: true });
            stepScreenshot = failurePath;
          } catch {
            // Screenshot on failure is best-effort
          }

          stepResults.push({
            action: step.action,
            description: step.description ?? step.action,
            passed: false,
            error: errorMsg,
            duration: Date.now() - stepStart,
            screenshot: stepScreenshot,
          });

          // Record first error for the scenario but continue executing remaining steps
          if (!scenarioError) {
            scenarioError = errorMsg;
          }
        }
      }

      // Take a final screenshot for the scenario
      try {
        const finalPath = join(
          screenshotDir,
          `${this.sanitizeFileName(scenario.name)}-final.png`,
        );
        await page.screenshot({ path: finalPath, fullPage: true });
        scenarioScreenshotPath = finalPath;
      } catch {
        // Best-effort
      }
    } catch (err) {
      scenarioError = err instanceof Error ? err.message : String(err);
    } finally {
      await context.close();
    }

    const allStepsPassed = stepResults.every((s) => s.passed);

    return {
      name: scenario.name,
      priority: scenario.priority,
      passed: allStepsPassed,
      steps: stepResults,
      error: scenarioError,
      screenshotPath: scenarioScreenshotPath,
      duration: Date.now() - scenarioStart,
    };
  }

  // -----------------------------------------------------------------------
  // Execute a single step
  // -----------------------------------------------------------------------

  private async executeStep(
    page: import('playwright').Page,
    step: ScenarioStep,
    baseUrl: string,
    screenshotDir: string,
    scenarioName: string,
  ): Promise<void> {
    const stepTimeout = step.timeout;

    switch (step.action) {
      case 'navigate': {
        const url = step.url?.startsWith('http') ? step.url : `${baseUrl}${step.url ?? '/'}`;
        await page.goto(url, { waitUntil: 'networkidle', timeout: stepTimeout });
        break;
      }

      case 'click': {
        if (!step.selector) {
          throw new Error("'click' action requires a 'selector'");
        }
        await page.click(step.selector, { timeout: stepTimeout });
        break;
      }

      case 'fill': {
        if (!step.selector) {
          throw new Error("'fill' action requires a 'selector'");
        }
        if (step.value === undefined || step.value === null) {
          throw new Error("'fill' action requires a 'value'");
        }
        await page.fill(step.selector, step.value, { timeout: stepTimeout });
        break;
      }

      case 'select': {
        if (!step.selector) {
          throw new Error("'select' action requires a 'selector'");
        }
        if (step.value === undefined || step.value === null) {
          throw new Error("'select' action requires a 'value'");
        }
        await page.selectOption(step.selector, step.value, { timeout: stepTimeout });
        break;
      }

      case 'wait': {
        if (step.selector) {
          await page.waitForSelector(step.selector, {
            state: 'visible',
            timeout: stepTimeout,
          });
        } else if (typeof step.value === 'string' && /^\d+$/.test(step.value)) {
          // Treat numeric string value as milliseconds
          await page.waitForTimeout(parseInt(step.value, 10));
        } else {
          // Default: wait for network idle
          await page.waitForLoadState('networkidle', { timeout: stepTimeout });
        }
        break;
      }

      case 'assert_visible': {
        if (!step.selector) {
          throw new Error("'assert_visible' action requires a 'selector'");
        }
        await page.waitForSelector(step.selector, {
          state: 'visible',
          timeout: stepTimeout,
        });
        break;
      }

      case 'assert_text': {
        if (!step.selector) {
          throw new Error("'assert_text' action requires a 'selector'");
        }
        const element = page.locator(step.selector);
        await element.waitFor({ state: 'visible', timeout: stepTimeout });
        const actualText = (await element.textContent()) ?? '';
        const expectedText = String(step.expected ?? '');
        if (!actualText.trim().includes(expectedText.trim())) {
          throw new Error(
            `assert_text failed: expected text to include "${expectedText}", but got "${actualText.trim()}"`,
          );
        }
        break;
      }

      case 'assert_url': {
        const actualUrl = page.url();
        const expectedUrl = String(step.expected ?? '');
        if (!actualUrl.includes(expectedUrl)) {
          throw new Error(
            `assert_url failed: expected URL to include "${expectedUrl}", but got "${actualUrl}"`,
          );
        }
        break;
      }

      case 'screenshot': {
        const screenshotPath =
          step.value ??
          join(screenshotDir, `${this.sanitizeFileName(scenarioName)}-${Date.now()}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: true });
        break;
      }

      case 'hover': {
        if (!step.selector) {
          throw new Error("'hover' action requires a 'selector'");
        }
        await page.hover(step.selector, { timeout: stepTimeout });
        break;
      }

      case 'press_key': {
        if (!step.value) {
          throw new Error("'press_key' action requires a 'value' (e.g. 'Enter', 'Tab')");
        }
        await page.keyboard.press(step.value);
        break;
      }

      case 'scroll': {
        // @ts-ignore -- globalThis.scrollTo runs in browser context via Playwright
        await page.evaluate(() => { globalThis.scrollTo(0, document.body.scrollHeight); });
        // Brief pause to let lazy-loaded content settle
        await page.waitForTimeout(500);
        break;
      }

      default: {
        throw new Error(`Unknown action: ${step.action}`);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private sanitizeFileName(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
  }

  private buildResult(
    passed: boolean,
    scenarios: ScenarioResult[],
    screenshots: string[],
    overallStart: number,
    summary: string,
  ): BusinessVerificationResult {
    return {
      passed,
      scenarios,
      summary,
      duration: Date.now() - overallStart,
      screenshots,
    };
  }
}

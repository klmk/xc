import { chromium, Browser, Page, BrowserContext } from 'playwright';
import type { TestResult, TestFailure } from '../types/index.js';

export interface E2ETestConfig {
  baseUrl: string;
  testCases: TestCase[];
  timeout?: number;
  headless?: boolean;
}

export interface TestCase {
  name: string;
  steps: TestStep[];
  expectedResult: string;
}

export interface TestStep {
  action: 'navigate' | 'click' | 'fill' | 'select' | 'wait' | 'assert' | 'screenshot';
  selector?: string;
  value?: string;
  url?: string;
  assertion?: {
    type: 'visible' | 'text' | 'value' | 'count';
    expected: string | number | boolean;
  };
  delay?: number;
}

export class E2ETestRunner {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  /**
   * 初始化浏览器
   */
  async init(headless: boolean = true): Promise<void> {
    this.browser = await chromium.launch({ headless });
    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 720 },
    });
    this.page = await this.context.newPage();
  }

  /**
   * 关闭浏览器
   */
  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.context = null;
      this.page = null;
    }
  }

  /**
   * 执行单个测试用例
   */
  private async runTestCase(testCase: TestCase): Promise<{ success: boolean; error?: string }> {
    if (!this.page) {
      throw new Error('Browser not initialized');
    }

    try {
      for (const step of testCase.steps) {
        await this.executeStep(step);
      }
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * 执行单个步骤
   */
  private async executeStep(step: TestStep): Promise<void> {
    if (!this.page) {
      throw new Error('Browser not initialized');
    }

    switch (step.action) {
      case 'navigate':
        if (!step.url) throw new Error('URL required for navigate action');
        await this.page.goto(step.url, { waitUntil: 'networkidle' });
        break;

      case 'click':
        if (!step.selector) throw new Error('Selector required for click action');
        await this.page.click(step.selector);
        break;

      case 'fill':
        if (!step.selector || step.value === undefined) {
          throw new Error('Selector and value required for fill action');
        }
        await this.page.fill(step.selector, step.value);
        break;

      case 'select':
        if (!step.selector || step.value === undefined) {
          throw new Error('Selector and value required for select action');
        }
        await this.page.selectOption(step.selector, step.value);
        break;

      case 'wait':
        if (step.delay) {
          await this.page.waitForTimeout(step.delay);
        } else if (step.selector) {
          await this.page.waitForSelector(step.selector, { state: 'visible' });
        } else {
          await this.page.waitForLoadState('networkidle');
        }
        break;

      case 'assert':
        if (!step.assertion) throw new Error('Assertion required for assert action');
        await this.executeAssertion(step.selector, step.assertion);
        break;

      case 'screenshot':
        await this.page.screenshot({ path: step.value || 'screenshot.png' });
        break;

      default:
        throw new Error(`Unknown action: ${step.action}`);
    }
  }

  /**
   * 执行断言
   */
  private async executeAssertion(
    selector: string | undefined,
    assertion: { type: string; expected: unknown }
  ): Promise<void> {
    if (!this.page) throw new Error('Browser not initialized');
    if (!selector) throw new Error('Selector required for assertion');

    const element = this.page.locator(selector);

    switch (assertion.type) {
      case 'visible':
        await element.waitFor({ state: 'visible' });
        break;

      case 'text':
        const text = await element.textContent();
        if (text?.trim() !== assertion.expected) {
          throw new Error(`Text assertion failed: expected "${assertion.expected}", got "${text}"`);
        }
        break;

      case 'value':
        const value = await element.inputValue();
        if (value !== assertion.expected) {
          throw new Error(`Value assertion failed: expected "${assertion.expected}", got "${value}"`);
        }
        break;

      case 'count':
        const count = await element.count();
        if (count !== assertion.expected) {
          throw new Error(`Count assertion failed: expected ${assertion.expected}, got ${count}`);
        }
        break;

      default:
        throw new Error(`Unknown assertion type: ${assertion.type}`);
    }
  }

  /**
   * 运行完整的E2E测试套件
   */
  async runTests(config: E2ETestConfig): Promise<TestResult> {
    const startTime = Date.now();
    const failures: TestFailure[] = [];
    let passedTests = 0;

    try {
      await this.init(config.headless ?? true);

      for (const testCase of config.testCases) {
        const result = await this.runTestCase(testCase);
        
        if (result.success) {
          passedTests++;
        } else {
          failures.push({
            testName: testCase.name,
            error: result.error || 'Test failed',
          });
        }
      }

      return {
        success: failures.length === 0,
        type: 'e2e',
        totalTests: config.testCases.length,
        passedTests,
        failedTests: failures.length,
        duration: Date.now() - startTime,
        logs: '',
        failures,
      };
    } finally {
      await this.close();
    }
  }

  /**
   * 从自然语言生成测试用例（使用LLM）
   */
  async generateTestCases(_requirement: string, prdFeatures: string[]): Promise<TestCase[]> {
    // 这里会调用LLM生成测试用例
    // 简化版本：返回基于PRD特性的默认测试用例
    const testCases: TestCase[] = [];

    for (const feature of prdFeatures) {
      testCases.push({
        name: `Test: ${feature}`,
        steps: [
          { action: 'navigate', url: 'http://localhost:3000' },
          { action: 'wait', delay: 1000 },
        ],
        expectedResult: `Feature "${feature}" should work correctly`,
      });
    }

    return testCases;
  }

  /**
   * 生成测试报告
   */
  generateReport(result: TestResult): string {
    const lines = [
      'E2E Test Report',
      '================',
      '',
      `Total: ${result.totalTests} tests`,
      `Passed: ${result.passedTests}`,
      `Failed: ${result.failedTests}`,
      `Duration: ${result.duration}ms`,
      '',
      result.success ? '✓ All tests passed!' : '✗ Some tests failed',
    ];

    if (result.failures.length > 0) {
      lines.push('', 'Failures:');
      for (const failure of result.failures) {
        lines.push(`  - ${failure.testName}: ${failure.error}`);
      }
    }

    return lines.join('\n');
  }
}
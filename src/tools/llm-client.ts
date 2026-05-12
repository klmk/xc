import OpenAI from 'openai';
import type { LLMResponse, AgentMessage } from '../types/index.js';

export interface LLMClientConfig {
  apiKey: string;
  baseURL?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export class LLMClient {
  private client: OpenAI;
  private config: Required<LLMClientConfig>;

  constructor(config: LLMClientConfig) {
    this.config = {
      baseURL: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      temperature: 0.7,
      maxTokens: 8192,
      ...config,
    };

    this.client = new OpenAI({
      apiKey: this.config.apiKey,
      baseURL: this.config.baseURL,
    });
  }

  /**
   * 发送单条消息获取回复
   */
  async complete(prompt: string, systemPrompt?: string): Promise<LLMResponse> {
    const messages: AgentMessage[] = [];
    
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    
    messages.push({ role: 'user', content: prompt });

    return this.chat(messages);
  }

  /**
   * 多轮对话
   */
  async chat(messages: AgentMessage[]): Promise<LLMResponse> {
    try {
      const response = await this.client.chat.completions.create({
        model: this.config.model,
        messages: messages.map(m => ({
          role: m.role,
          content: m.content,
        })),
        temperature: this.config.temperature,
        max_tokens: this.config.maxTokens,
      });

      const choice = response.choices[0];
      if (!choice?.message?.content) {
        throw new Error('Empty response from LLM');
      }

      return {
        content: choice.message.content,
        usage: response.usage ? {
          promptTokens: response.usage.prompt_tokens,
          completionTokens: response.usage.completion_tokens,
          totalTokens: response.usage.total_tokens,
        } : undefined,
      };
    } catch (error) {
      console.error('LLM API error:', error);
      throw new Error(`LLM request failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * 结构化输出（使用JSON模式）
   */
  async completeStructured<T>(
    prompt: string,
    schema: object,
    systemPrompt?: string
  ): Promise<T> {
    const fullPrompt = `${systemPrompt ? systemPrompt + '\n\n' : ''}${prompt}\n\nYou must respond with valid JSON only, following this schema:\n${JSON.stringify(schema, null, 2)}`;

    const response = await this.complete(fullPrompt);
    
    try {
      // 尝试提取JSON（处理可能的markdown代码块）
      const jsonMatch = response.content.match(/```json\n?([\s\S]*?)```/) || 
                       response.content.match(/```\n?([\s\S]*?)```/) ||
                       [null, response.content];
      
      const jsonStr = jsonMatch[1]?.trim() || response.content.trim();
      return JSON.parse(jsonStr) as T;
    } catch (error) {
      console.error('Failed to parse structured response:', response.content);
      throw new Error(`Failed to parse structured output: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * 流式输出（用于长文本生成）
   */
  async *streamComplete(prompt: string, systemPrompt?: string): AsyncGenerator<string> {
    const messages: AgentMessage[] = [];
    
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    
    messages.push({ role: 'user', content: prompt });

    const stream = await this.client.chat.completions.create({
      model: this.config.model,
      messages: messages.map(m => ({
        role: m.role,
        content: m.content,
      })),
      temperature: this.config.temperature,
      max_tokens: this.config.maxTokens,
      stream: true,
    });

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        yield content;
      }
    }
  }

  /**
   * 代码生成专用（低temperature，更确定性）
   */
  async generateCode(prompt: string, context?: string): Promise<string> {
    const systemPrompt = `You are an expert software developer. Write clean, well-documented, production-ready code.
Follow these guidelines:
- Use modern best practices
- Include error handling
- Write self-documenting code with clear variable names
- Add comments for complex logic
- Ensure code is complete and runnable
${context ? '\nContext:\n' + context : ''}`;

    const response = await this.complete(prompt, systemPrompt);
    return response.content;
  }

  /**
   * 代码修复专用
   */
  async fixCode(code: string, error: string, context?: string): Promise<string> {
    const prompt = `Fix the following code that has an error.

## Original Code:
\`\`\`
${code}
\`\`\`

## Error:
\`\`\`
${error}
\`\`\`

${context ? `## Additional Context:\n${context}\n` : ''}

Please provide the fixed code. Only return the code, no explanations.`;

    const systemPrompt = `You are an expert at debugging and fixing code. Analyze the error carefully and provide a correct fix.
Ensure the fixed code:
- Resolves the reported error
- Maintains the original functionality
- Follows best practices`;

    const response = await this.complete(prompt, systemPrompt);
    
    // 尝试提取代码块
    const codeMatch = response.content.match(/```[\w]*\n?([\s\S]*?)```/);
    return codeMatch ? codeMatch[1].trim() : response.content.trim();
  }
}
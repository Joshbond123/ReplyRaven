import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { AIKeyRotator, AI_SYSTEM } from '../../lib/ai.js';
import { APIError } from '../../lib/api.js';
/** Actions uses the official OpenAI/Gemini SDKs; the browser stays dependency-free. */
export class SDKAIKeyRotator extends AIKeyRotator {
  async generateWith(key, prompt) {
    let text;
    if (['openai', 'gpt', 'groq'].includes(key.provider)) {
      const client = new OpenAI({
        apiKey: key.api_key,
        maxRetries: 0,
        timeout: 60000,
        fetch: this.fetcher,
        ...(key.provider === 'groq' ? { baseURL: 'https://api.groq.com/openai/v1' } : {}),
      });
      const response = await client.chat.completions.create({
        model: key.model_name,
        messages: [
          { role: 'system', content: AI_SYSTEM },
          { role: 'user', content: prompt },
        ],
        temperature: 0.65,
        max_tokens: 300,
      });
      text = response.choices?.[0]?.message?.content;
    } else if (key.provider === 'gemini') {
      const ai = new GoogleGenerativeAI(key.api_key);
      const model = ai.getGenerativeModel({
        model: key.model_name,
        systemInstruction: AI_SYSTEM,
        generationConfig: {
          temperature: 0.65,
          maxOutputTokens: 1000,
          ...(/gemini-2\.5-flash/.test(key.model_name) ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
        },
      });
      const response = await model.generateContent(prompt, { timeout: 60000 });
      text = response.response.text();
    } else {
      return super.generateWith(key, prompt);
    }
    text = String(text || '').trim();
    if (!text || text.length > 4096) throw new APIError('AI returned an empty or oversized reply.', 502);
    return text;
  }
}

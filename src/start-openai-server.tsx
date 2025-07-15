import { AI, getPreferenceValues, showToast, Toast } from "@raycast/api";
import http from "http";

interface Preferences {
  port: string;
}


interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/**
 * Formats messages into model-specific prompt formats
 * Different AI models expect different prompt structures
 * @param messages Array of chat messages
 * @param modelId Model identifier string
 * @returns Formatted prompt string
 */
function formatPromptForModel(messages: Message[], modelId: string): string {
  // Convert to lowercase for case-insensitive matching
  const modelIdLower = modelId.toLowerCase();

  // Llama 3.1 and newer versions
  if (modelIdLower.includes('llama3.1') || modelIdLower.includes('llama-4')) {
    return formatLlama3(messages);
  }

  // Llama 3 (legacy)
  if (modelIdLower.includes('llama3') || modelIdLower.includes('llama-3.3')) {
    return formatLlama3(messages);
  }

  // Llama 2 and CodeLlama
  if (modelIdLower.includes('llama2') || modelIdLower.includes('codellama')) {
    return formatLlama2(messages);
  }

  // Mistral family models
  if (modelIdLower.includes('mistral') || modelIdLower.includes('nemo') || modelIdLower.includes('codestral')) {
    return formatMistral(messages);
  }

  // Anthropic Claude family
  if (modelIdLower.includes('anthropic') || modelIdLower.includes('claude')) {
    return formatClaude(messages);
  }

  // Grok family
  if (modelIdLower.includes('grok')) {
    return formatGrok(messages);
  }

  // DeepSeek family (typically compatible with Llama2 format)
  if (modelIdLower.includes('deepseek')) {
    return formatLlama2(messages);
  }

  // OpenAI & Google Gemini
  if (modelIdLower.includes('openai') || modelIdLower.includes('google') || modelIdLower.includes('gemini')) {
    // These models natively use JSON format via their APIs.
    // This is a fallback string representation for compatibility.
    return formatSimpleChat(messages, modelIdLower.includes('openai'));
  }

  // Default format for unknown models
  return formatDefault(messages);
}

// -----------------------------------------------------------------------------
// Model-specific formatting functions
// -----------------------------------------------------------------------------

/**
 * Llama 3 & 3.1 format
 * Uses special tokens: <|begin_of_text|>, <|start_header_id|>, <|end_header_id|>, <|eot_id|>
 */
function formatLlama3(messages: Message[]): string {
  let prompt = '<|begin_of_text|>';

  messages.forEach(msg => {
    const role = msg.role === 'assistant' ? 'assistant' : (msg.role === 'system' ? 'system' : 'user');
    prompt += `<|start_header_id|>${role}<|end_header_id|>\n\n${msg.content}<|eot_id|>`;
  });

  prompt += `<|start_header_id|>assistant<|end_header_id|>\n\n`;
  return prompt;
}

/**
 * Llama 2 format
 * Uses special tokens: <s>, [INST], [/INST], <<SYS>>
 */
function formatLlama2(messages: Message[]): string {
  let prompt = '<s>';
  let hasSystemPrompt = false;

  // Handle system message
  if (messages[0]?.role === 'system') {
    prompt += `[INST] <<SYS>>\n${messages[0].content}\n<</SYS>>\n\n`;
    hasSystemPrompt = true;
  }

  // Process remaining messages
  messages.slice(hasSystemPrompt ? 1 : 0).forEach((msg) => {
    if (msg.role === 'user') {
      prompt += `[INST] ${msg.content} [/INST]`;
    } else if (msg.role === 'assistant') {
      prompt += ` ${msg.content} </s><s>`;
    }
  });

  // Remove trailing <s> if present
  if (prompt.endsWith('<s>')) {
    prompt = prompt.slice(0, -3);
  }

  return prompt;
}

/**
 * Mistral format
 * Uses special tokens: <s>, [INST], [/INST]
 */
function formatMistral(messages: Message[]): string {
  let prompt = '<s>';

  messages.forEach(msg => {
    if (msg.role === 'user') {
      prompt += `[INST] ${msg.content} [/INST]`;
    } else if (msg.role === 'assistant') {
      prompt += `${msg.content}</s>`;
    }
  });

  return prompt;
}

/**
 * Claude format
 * Uses conversational format with "User:" and "Assistant:" prefixes
 */
function formatClaude(messages: Message[]): string {
  let prompt = '';

  messages.forEach(msg => {
    if (msg.role === 'system') {
      // Claude 3+ recommends placing system instructions before the first User message
      prompt += `${msg.content}\n\n`;
    } else if (msg.role === 'user') {
      prompt += `User: ${msg.content}\n\n`;
    } else if (msg.role === 'assistant') {
      prompt += `Assistant: ${msg.content}\n\n`;
    }
  });

  prompt += 'Assistant:';
  return prompt;
}

/**
 * Grok format
 * Uses simple instruction format with clear role labels
 */
function formatGrok(messages: Message[]): string {
  let prompt = '';

  messages.forEach(msg => {
    if (msg.role === 'system') {
      prompt += `System Instruction:\n${msg.content}\n\n`;
    } else if (msg.role === 'user') {
      prompt += `User:\n${msg.content}\n\n`;
    } else if (msg.role === 'assistant') {
      prompt += `Assistant:\n${msg.content}\n\n`;
    }
  });

  prompt += 'Assistant:\n';
  return prompt;
}

/**
 * Simple chat format for OpenAI/Gemini
 * This is a fallback as these models primarily use JSON message arrays
 */
function formatSimpleChat(messages: Message[], isSystemSupported: boolean): string {
  return messages
    .map(msg => {
      // Gemini doesn't support system role, merge it into user message
      if (!isSystemSupported && msg.role === 'system') {
        return `(System Instruction: ${msg.content})`;
      }
      return `${msg.role}: ${msg.content}`;
    })
    .join('\n\n');
}

/**
 * Default format for unknown models
 * Uses simple <role>: content format
 */
function formatDefault(messages: Message[]): string {
  return messages
    .map(msg => `<${msg.role}>: ${msg.content}`)
    .join('\n\n');
}

export default async function Command() {
  const preferences = getPreferenceValues<Preferences>();
  console.log("Read preferences:", JSON.stringify(preferences));
  const { port } = preferences;
  console.log("Read port from preferences:", port);
  const portNumber = Number(port);
  if (Number.isNaN(portNumber)) {
    showToast({
      style: Toast.Style.Failure,
      title: "Invalid Port",
      message: "The port is invalid. Please set a valid number in the preferences."
    });
    return;
  }

  // Start an HTTP server
  const server = http.createServer(async (req, res) => {
    // If the request is a kill command, shut down the server.
    if (req.method === "POST" && req.url === "/kill") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "Server shutting down" }));
      server.close();
      return;
    }

    if (req.method === "GET" && req.url === "/v1/models") {
      const models = Object.values(AI.Model).map((modelName, index) => {
        return { id: index.toString(), name: modelName };
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(models));
      return;
    }

    // Existing endpoint for chat completions.
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Endpoint not found" }));
      return;
    }

    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      try {
        const requestData = JSON.parse(body);
        console.log("Request body:", JSON.stringify(requestData, null, 2));
        const model = requestData.model || "OpenAI_GPT4o-mini";
        if (!requestData.messages || !Array.isArray(requestData.messages)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Missing or invalid 'messages' in request body" }));
          return;
        }

        const prompt = formatPromptForModel(requestData.messages, model);

        if (!prompt) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Missing 'content' in the last message" }));
          return;
        }

        // Determine whether streaming is enabled.
        const streamMode = requestData.stream === true;

        console.log("Will send prompt to model:", model, prompt);

        // Call AI.ask with the prompt.
        const answer = AI.ask(prompt, { model: AI.Model[model] });

        if (streamMode) {
          // Streaming response: set headers for SSE.
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
          });

          answer.on("data", (data: Buffer | string) => {
            res.write("data: " + JSON.stringify({
              id: "chatcmpl-xyz",
              object: "chat.completion",
              model: model,
              created: Math.floor(Date.now() / 1000),
              choices: [{ delta: { content: data.toString() } }]
            }) + "\n\n");
          });

          answer.then(() => {
            res.write("data: " + JSON.stringify({
              id: "chatcmpl-xyz",
              object: "chat.completion",
              created: Math.floor(Date.now() / 1000),
              model: model,
              choices: [{ delta: { content: "" } }],
              finish_reason: "stop"
            }) + "\n\n");
            res.write("data: [DONE]\n\n");
            res.end();
          }).catch((err: any) => {
            res.write("data: " + JSON.stringify({ error: err.message }) + "\n\n");
            res.end();
          });
        } else {
          // Non-streaming mode: await the full response and send it as JSON.
          const result = await answer;
          const responseBody = {
            id: "chatcmpl-xyz",
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: model,
            choices: [{
              index: 0,
              message: {
                role: "assistant",
                content: result
              },
              finish_reason: "stop"
            }],
            usage: {}
          };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(responseBody));
        }
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  });

  server.listen(portNumber, () => {
    console.log(`Server is listening on port ${portNumber}`);
  });

  // Listen for the 'close' event and print a message when the server shuts down.
  server.on("close", () => {
    console.log("Server has been shut down.");
  });

  await new Promise(() => { });
}

import json
import time
import traceback
import ollama
from google import genai
from google.genai import types
from openai import OpenAI, APITimeoutError, APIConnectionError, APIStatusError
from ..config import OPENAI_API_KEY, LLM_TIMEOUT_SECONDS, LLM_MAX_OUTPUT_TOKENS, AVAILABLE_BASE_URLS


def chat_with_llm(messages: list, model_name: str) -> str:

    if "gemini" in model_name.lower():
        dynamic_base_url = AVAILABLE_BASE_URLS[0]
    else:
         dynamic_base_url = AVAILABLE_BASE_URLS[1]

    client = OpenAI(
        api_key=OPENAI_API_KEY,
        base_url=dynamic_base_url,
        max_retries=0               # to avoid wasting requests with automatic retries when the server is not reachable
    )

    print("\n" + "="*70)
    print(f"[DEBUG LLM] LLM CALL TO MODEL: {model_name}")

    payload_length = sum(len(str(m.get("content", ""))) for m in messages)
    
    print(f"[DEBUG LLM] PAYLOAD SIZE: ~{payload_length} characters")
    print(f"[DEBUG LLM] NUMBER OF MESSAGES: {len(messages)}")
    print(json.dumps(messages, indent=2)) 
    print("="*70 + "\n")

    start_time = time.time()

    try:

        response = client.chat.completions.create(
            model=model_name,
            messages=messages,
            temperature=0.2,
            response_format={"type": "json_object"},
            timeout=LLM_TIMEOUT_SECONDS,
            max_tokens=LLM_MAX_OUTPUT_TOKENS
        )

        elapsed_time = time.time() - start_time

        print(f"\n[DEBUG LLM] --- RESPONSE RECEIVED IN {elapsed_time:.2f} SECONDS ---")

        if not getattr(response, "choices", None):
            print("[DEBUG LLM] ERROR: response.choices is empty or missing")
            raise ValueError("LLM_EMPTY_CHOICES")

        choice0 = response.choices[0]
        finish_reason = getattr(choice0, "finish_reason", None)
        message = getattr(choice0, "message", None)
        content = getattr(message, "content", None) if message else None

        print(f"[DEBUG LLM] FINISH REASON: {finish_reason}")
        print(f"[DEBUG LLM] MESSAGE PRESENT: {message is not None}")
        print(f"[DEBUG LLM] CONTENT TYPE: {type(content).__name__ if content is not None else 'None'}")
        print(f"[DEBUG LLM] CONTENT IS NONE: {content is None}")
        print(f"[DEBUG LLM] CONTENT LENGTH: {len(content) if isinstance(content, str) else 'N/A'}")

        if content is None:
            raise ValueError(f"LLM_EMPTY_CONTENT_NONE | finish_reason={finish_reason}")

        if isinstance(content, str) and not content.strip():
            raise ValueError(f"LLM_EMPTY_CONTENT_BLANK | finish_reason={finish_reason}")

        return content

    except APITimeoutError as e:
        elapsed_time = time.time() - start_time
        print(f"[DEBUG LLM] TIMEOUT AFTER {elapsed_time:.2f} SECONDS")
        raise TimeoutError(f"LLM_PROVIDER_TIMEOUT after {elapsed_time:.2f}s") from e

    except APIConnectionError as e:
        elapsed_time = time.time() - start_time
        print(f"[DEBUG LLM] CONNECTION ERROR AFTER {elapsed_time:.2f} SECONDS: {e}")
        raise ConnectionError(f"LLM_CONNECTION_ERROR after {elapsed_time:.2f}s: {e}") from e

    except APIStatusError as e:
        elapsed_time = time.time() - start_time
        status_code = getattr(e, "status_code", "unknown")
        print(f"[DEBUG LLM] API STATUS ERROR AFTER {elapsed_time:.2f} SECONDS: status={status_code}")
        raise RuntimeError(f"LLM_API_STATUS_ERROR status={status_code} after {elapsed_time:.2f}s") from e

    except Exception as e:
        elapsed_time = time.time() - start_time
        print(f"[DEBUG LLM] UNEXPECTED ERROR AFTER {elapsed_time:.2f} SECONDS: {e}")
        print(traceback.format_exc())
        raise RuntimeError(f"LLM_UNEXPECTED_ERROR after {elapsed_time:.2f}s: {e}") from e

# stream mode to send reasoning content to the client in real time
def chat_with_llm_stream(messages: list, model_name: str):

    print("\n" + "="*70)
    print(f"[DEBUG LLM] NATIVE LLM CALL TO MODEL (STREAMING): {model_name}")
    payload_length = sum(len(str(m.get("content", ""))) for m in messages)
    print(f"[DEBUG LLM] PAYLOAD SIZE: ~{payload_length} characters")
    print(f"[DEBUG LLM] NUMBER OF MESSAGES: {len(messages)}")
    print(json.dumps(messages, indent=2)) 
    print("="*70 + "\n")

    start_time = time.time()
    json_output_only = ""

    try:
        # use gemini API for gemini models
        if "gemini" in model_name.lower():
            client = genai.Client(api_key=OPENAI_API_KEY)
            
            gemini_messages = []
            # variable that contains system prompt
            system_instruction = None
            
            for m in messages:
                if m["role"] == "system":
                    system_instruction = m["content"]
                else:
                    # assign role of the message
                    gemini_role = "user" if m["role"] == "user" else "model"
                    # create the message json with role and text
                    gemini_messages.append({"role": gemini_role, "parts": [{"text": m["content"]}]})
            
            config = types.GenerateContentConfig(
                temperature=0.2,
                max_output_tokens=LLM_MAX_OUTPUT_TOKENS,
                system_instruction=system_instruction,
                thinking_config=types.ThinkingConfig(include_thoughts=True, thinking_budget=4096)               # enable reasoning in the request
            )
            
            response = client.models.generate_content_stream(
                model=model_name,
                contents=gemini_messages,
                config=config
            )
            
            for chunk in response:
                # ensure the chunk contains at least one candidate with content parts
                if chunk.candidates:
                    candidate = chunk.candidates[0]
                    if candidate.content and candidate.content.parts:
                        for part in candidate.content.parts:
                            if getattr(part, "thought", False):
                                # this part is marked as "thought" (reasoning content)
                                yield {"type": "thought", "content": part.text}
                            elif part.text:
                                # this is regular response content (not reasoning)
                                json_output_only += part.text
                                yield {"type": "content", "content": part.text}

                    finish_reason = getattr(candidate, "finish_reason", None)
                    if finish_reason and ("MAX_TOKENS" in str(finish_reason).upper() or finish_reason == 2):
                        yield {"type": "error", "content": "finish_reason: length (Max token limit reached)"}

        # use ollama api (DeepSeek, Qwen, GLM, Gemma)
        else:
            # use native Ollama client
            ollama_base_url = AVAILABLE_BASE_URLS[1].rstrip("/v1")
            ollama_client = ollama.Client(host=ollama_base_url, timeout= LLM_TIMEOUT_SECONDS)
            
            response = ollama_client.chat(
                model=model_name,
                messages=messages,
                stream=True,
                think=True,                                                                                         # activate thinking
                options={"temperature": 0.2, "num_predict": LLM_MAX_OUTPUT_TOKENS}
            )
            
            for chunk in response:
                # extract the message dictionary from the Ollama chunk
                message = chunk.get('message', {})
                
                # extract thinking and real content from the response
                thought = message.get('thinking')
                content = message.get('content')

                # if the model emitted a "thinking" field, yield it as a thought event
                if thought:
                    yield {"type": "thought", "content": thought}

                # if the model emitted regular content, yield it as a content event
                if content:
                    json_output_only += content
                    yield {"type": "content", "content": content}

                # get reason for which the LLM stop genrating the response
                if chunk.get("done"):
                    done_reason = chunk.get("done_reason", "")
                    if done_reason and done_reason.lower() in ["length", "max_tokens"]:
                        yield {"type": "error", "content": f"finish_reason: {done_reason} (Max token limit reached)"}

        elapsed_time = time.time() - start_time
        print(f"\n[DEBUG LLM] --- NATIVE STREAM COMPLETED IN {elapsed_time:.2f} SECONDS ---")
        print(f"[DEBUG LLM] JSON OUTPUT:\n{json_output_only}\n" + "="*70 + "\n")    

    except Exception as e:
        elapsed_time = time.time() - start_time
        # get the name of the error
        error_type = type(e).__name__
        error_text = str(e).lower()

        print(f"[DEBUG LLM] {error_type} Error during streaming: {e}")
        traceback.print_exc()

        if "timeout" in error_type.lower() or "timeout" in error_text:
            error_msg = f"LLM_PROVIDER_TIMEOUT after {elapsed_time:.2f}s: {e}"
        elif "connection" in error_type.lower() or "connection" in error_text or "network" in error_text:
            error_msg = f"LLM_CONNECTION_ERROR after {elapsed_time:.2f}s: {e}"
        elif "status" in error_type.lower() or "40" in error_text or "50" in error_text:
            error_msg = f"LLM_API_STATUS_ERROR ({error_type}) after {elapsed_time:.2f}s: {e}"
        else:
            error_msg = f"LLM_UNEXPECTED_ERROR ({error_type}) after {elapsed_time:.2f}s: {e}"

        yield {"type": "error", "content": error_msg}
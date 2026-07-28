import json
import time
import traceback
from openai import OpenAI, APITimeoutError, APIConnectionError, APIStatusError
from ..config import OPENAI_API_KEY, OPENAI_BASE_URL, LLM_MODEL, LLM_TIMEOUT_SECONDS, LLM_MAX_OUTPUT_TOKENS

client = OpenAI(
    api_key=OPENAI_API_KEY,
    base_url=OPENAI_BASE_URL,
    max_retries=0               # to avoid wasting requests with automatic retries when the server is not reachable
)

def chat_with_llm(messages: list) -> str:

    print("\n" + "="*70)
    print(f"[DEBUG LLM] LLM CALL TO MODEL: {LLM_MODEL}")

    payload_length = sum(len(str(m.get("content", ""))) for m in messages)
    
    print(f"[DEBUG LLM] PAYLOAD SIZE: ~{payload_length} characters")
    print(f"[DEBUG LLM] NUMBER OF MESSAGES: {len(messages)}")
    print(json.dumps(messages, indent=2)) 
    print("="*70 + "\n")

    start_time = time.time()

    try:

        response = client.chat.completions.create(
            model=LLM_MODEL,
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
from openai import OpenAI
from ..config import OPENAI_API_KEY, OPENAI_BASE_URL, LLM_MODEL

client = OpenAI(
    api_key=OPENAI_API_KEY,
    base_url=OPENAI_BASE_URL,
    max_retries=0               # to avoid wasting requests with automatic retries when the server is not reachable
)

def chat_with_llm(messages: list) -> str:
    response = client.chat.completions.create(
        model=LLM_MODEL,
        messages=messages,
        temperature=0.2,
        response_format={"type": "json_object"}
    )
    return response.choices[0].message.content
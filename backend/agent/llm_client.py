from openai import OpenAI
from ..config import GEMINI_API_KEY, GEMINI_BASE_URL, LLM_MODEL

client = OpenAI(
    api_key=GEMINI_API_KEY,
    base_url=GEMINI_BASE_URL
)

def chat_with_llm(messages: list) -> str:
    response = client.chat.completions.create(
        model=LLM_MODEL,
        messages=messages
    )
    return response.choices[0].message.content
from openai import OpenAI
from ..config import OPENAI_API_KEY, OPENAI_BASE_URL, LLM_MODEL

client = OpenAI(
    api_key=OPENAI_API_KEY,
    base_url=OPENAI_BASE_URL
)

def chat_with_llm(messages: list) -> str:
    response = client.chat.completions.create(
        model=LLM_MODEL,
        messages=messages
    )
    return response.choices[0].message.content
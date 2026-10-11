
import os
from dotenv import load_dotenv
from google import genai

load_dotenv()

api_key = os.getenv("GEMINI_API_KEY")
model = os.getenv("GEMINI_MODEL", "gemini-3.1-flash-lite")

if not api_key:
    raise RuntimeError(
        "GEMINI_API_KEY is missing. Check backend/.env."
    )

client = genai.Client(api_key=api_key)

response = client.models.generate_content(
    model=model,
    contents=(
        "You are testing LexProof AI. "
        "Reply with: LexProof AI AI connection successful."
    ),
)

print("Model:", model)
print("Response:", response.text)

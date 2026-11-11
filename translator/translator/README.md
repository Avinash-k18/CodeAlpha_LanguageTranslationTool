# Bridge – Language Translation Tool

Flask backend + vanilla JS frontend.

## Run
    python -m venv venv && source venv/bin/activate     # Windows: venv\Scripts\activate
    pip install -r requirements.txt
    python app.py
Open http://localhost:5000

## API
- GET  /api/languages
- GET  /api/health
- POST /api/translate   {"text": "...", "source": "auto|en|...", "target": "hi"}

## Translation provider
Default: MyMemory (free, no key). To use Google Cloud Translation, copy `.env.example` to `.env` and set GOOGLE_API_KEY.

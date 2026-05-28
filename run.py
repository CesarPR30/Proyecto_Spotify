"""
run.py — entry point for the Sonic Dimensions web app.

Usage:
    pip install -r requirements.txt
    # Place data/data.csv (Kaggle schema) in ./data/ before running.
    python run.py
    # then open http://127.0.0.1:5001
"""
from app import app

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5001, debug=False)

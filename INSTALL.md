# WhaleMind MCP - Setup Guide

## 1. Install dependencies

If `pip` is not recognized, use one of these:

```bash
python -m pip install -r requirements.txt
```

or on Windows:

```bash
py -m pip install -r requirements.txt
```

## 2. PostgreSQL (optional)

The API works **without PostgreSQL**—it will analyze wallets and return results, but won't save them to the database.

To use the database:
- Install PostgreSQL: https://www.postgresql.org/download/
- Create a database: `createdb whalemind`
- Ensure PostgreSQL is running and `DATABASE_URL` in `.env` is correct

If PostgreSQL is not running, the API will start anyway and show a warning.

## 3. Run the API

```bash
python api.py
```

Then test with:

```bash
python test_api.py
```

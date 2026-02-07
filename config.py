"""
WhaleMind MCP - Shared config and logging setup.
"""

import logging
import os
import sys

from dotenv import load_dotenv

load_dotenv()

LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()
LOG_FORMAT = "%(asctime)s [%(levelname)s] %(name)s: %(message)s"


def setup_logging(level: str | None = None):
    """Configure logging for the application."""
    lvl = (level or LOG_LEVEL)
    try:
        numeric = getattr(logging, lvl)
    except AttributeError:
        numeric = logging.INFO
    logging.basicConfig(
        level=numeric,
        format=LOG_FORMAT,
        stream=sys.stderr,
        datefmt="%Y-%m-%d %H:%M:%S",
    )


def get_logger(name: str) -> logging.Logger:
    """Return a logger for the given module name."""
    return logging.getLogger(name)

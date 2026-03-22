"""
Task definitions for the FeatureGenerator crew.

This project uses direct function calls rather than CrewAI's Task abstraction
because Agent 3 (codegen) requires parallel execution that CrewAI's sequential
task model doesn't natively express.  The orchestration lives in crew.py.

This file is kept for structural completeness and future CrewAI integration.
"""

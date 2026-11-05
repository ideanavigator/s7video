# SPDX-FileCopyrightText: 2026 s7video contributors
# SPDX-License-Identifier: MIT
"""`python -m s7engine`: the engine on stdio. The server starts it; people never run it directly."""

from .methods import all_methods
from .rpc import run

run(all_methods())

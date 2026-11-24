# Proposal: close interrupted review sessions

Close each headless review process's own session on SIGTERM and on setup failure after its session is created. Preserve the signal's failure exit code and leave other sessions, timeout settings, and existing history untouched.

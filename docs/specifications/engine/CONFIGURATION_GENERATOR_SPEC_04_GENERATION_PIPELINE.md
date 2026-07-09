# Configuration Generator Specification - Part 04 - Generation Pipeline

## Pipeline

1.  Read database objects
2.  Validate objects
3.  Build internal model
4.  Generate engine configuration
5.  Validate generated configuration
6.  Produce configuration diff
7.  Create version
8.  Deploy through Engine Adapter
9.  Verify engine health
10. Record audit trail

Generation must be deterministic.

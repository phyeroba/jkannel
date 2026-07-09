# Routing Engine Specification - Part 04 - Rule Evaluation

## Processing Order

1.  Validate message
2.  Identify customer
3.  Match sender ID
4.  Match destination
5.  Evaluate route rules
6.  Select SMSC
7.  Apply throttling
8.  Submit message
9.  Record audit event

The first valid rule with the highest priority wins unless load
balancing is configured.

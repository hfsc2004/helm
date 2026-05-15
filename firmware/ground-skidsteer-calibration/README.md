# Ground Skid-Steer Calibration

Bench-test sketch for tuning left/right motor balance on the skid-steer robot.

Flash this temporarily, run on the bench (wheels off the ground), and tune `LEFT_BASE` / `RIGHT_BASE` and the `INVERT_*` flags until both wheels turn at matched speed in the same direction.

Once calibrated, transfer the numbers into `../ground-skidsteer/Robot_WiFi_Remote_Control_v1.ino` (`LEFT_TRIM`, `RIGHT_TRIM`, `INVERT_LEFT_MOTOR`, `INVERT_RIGHT_MOTOR`) and reflash the main firmware.

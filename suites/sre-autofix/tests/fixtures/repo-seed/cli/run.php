<?php

require __DIR__ . "/../app/service/ExampleSrv.php";

echo ExampleSrv::isFeatureEnabled((int) ($argv[1] ?? 0)) ? "on" : "off";

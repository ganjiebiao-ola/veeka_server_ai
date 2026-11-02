<?php

class ExampleSrv
{
	public static function isFeatureEnabled($uid)
	{
		if (empty($uid)) {
			return false;
		}

		// check if enabled
		$res = RpcExample::IsFeatureEnabled($uid);
		Helper::debugger()->info('IsFeatureEnabled res: ' . json_encode($res));
		if ($res === false || empty($res)) {
			throw new \Exception(__T('ERROR_SERVICE_ABNORMAL_TRY_AGAIN'));
		}
		if (is_string($res)) {
			throw new \Exception($res);
		}

		// not enabled
		return (bool) $res['enabled'];
	}
}
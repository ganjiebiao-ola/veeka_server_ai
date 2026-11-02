<?php
function sql_candidates($db, $pdo, $mysqli, $input) {
    // ruleid: php-string-built-sql
    $db->query("SELECT * FROM users WHERE name = '" . $input . "'");
    $sql = "SELECT * FROM users WHERE id = $input";
    // ruleid: php-string-built-sql
    $db->execute($sql);
    $sql2 = sprintf("SELECT * FROM users WHERE name = '%s'", $input);
    // ruleid: php-string-built-sql
    mysqli_query($mysqli, $sql2);
    // ruleid: php-string-built-sql
    $pdo->query("SELECT * FROM users WHERE id = " . $input);
    // ruleid: php-string-built-sql
    $pdo->exec("DELETE FROM users WHERE id = $input");
    // ruleid: php-string-built-sql
    $mysqli->query("SELECT * FROM users WHERE id = $input");
    // ruleid: php-string-built-sql
    $db->fetchOne("SELECT * FROM users WHERE id = $input");
    $appended = "SELECT * FROM users WHERE id = ";
    $appended .= $input;
    // ruleid: php-string-built-sql
    $db->execute($appended);
    // ruleid: php-string-built-sql
    mysqli_real_query($mysqli, "SELECT * FROM users WHERE id = $input");
    // ruleid: php-string-built-sql
    mysqli_multi_query($mysqli, "DELETE FROM users WHERE id = " . $input);
    // ruleid: php-string-built-sql
    mysqli_execute_query($mysqli, "SELECT * FROM users WHERE id = " . $input);
    // ok: php-string-built-sql
    $db->execute("SELECT * FROM users WHERE id = ?", [$input]);
    // ok: php-string-built-sql
    $stmt = $pdo->prepare("SELECT * FROM users WHERE id = ?");
    // ok: php-string-built-sql
    $stmt->execute([$input]);
    // ok: php-string-built-sql
    mysqli_query($mysqli, "SELECT * FROM users");
}
function command_candidates($input, $pipes) {
    // ruleid: php-nonliteral-command
    exec($input);
    // ruleid: php-nonliteral-command
    system("echo " . $input);
    // ruleid: php-nonliteral-command
    shell_exec("echo $input");
    // ruleid: php-nonliteral-command
    passthru($input);
    // ruleid: php-nonliteral-command
    popen($input, 'r');
    // ruleid: php-nonliteral-command
    proc_open($input, [], $pipes);
    // ruleid: php-nonliteral-command
    $result = `echo $input`;
    // ok: php-nonliteral-command
    exec('date');
    // ok: php-nonliteral-command
    system("date");
    // ok: php-nonliteral-command
    $result = `date`;
}
function deserialization_candidates($input, $options) {
    // ruleid: php-unsafe-unserialize
    unserialize($input);
    // ruleid: php-unsafe-unserialize
    unserialize($input, ['allowed_classes' => true]);
    // ruleid: php-unsafe-unserialize
    unserialize($input, ['allowed_classes' => ['User']]);
    // ruleid: php-unsafe-unserialize
    unserialize($input, $options);
    // ok: php-unsafe-unserialize
    unserialize($input, ['allowed_classes' => false]);
    // ok: php-unsafe-unserialize
    unserialize($input, array('allowed_classes' => false));
    // ok: php-unsafe-unserialize
    unserialize($input, ['max_depth' => 32, 'allowed_classes' => false]);
}

function tls_candidates($handle, $client) {
    // ruleid: php-tls-verify-off
    curl_setopt($handle, CURLOPT_SSL_VERIFYPEER, false);
    // ruleid: php-tls-verify-off
    curl_setopt($handle, CURLOPT_SSL_VERIFYPEER, 0);
    // ruleid: php-tls-verify-off
    curl_setopt($handle, CURLOPT_SSL_VERIFYHOST, 0);
    // ruleid: php-tls-verify-off
    curl_setopt($handle, CURLOPT_SSL_VERIFYHOST, false);
    // ruleid: php-tls-verify-off
    curl_setopt_array($handle, [CURLOPT_SSL_VERIFYPEER => false]);
    // ruleid: php-tls-verify-off
    curl_setopt_array($handle, array(CURLOPT_SSL_VERIFYPEER => 0));
    // ruleid: php-tls-verify-off
    curl_setopt_array($handle, [CURLOPT_SSL_VERIFYHOST => 0]);
    // ruleid: php-tls-verify-off
    curl_setopt_array($handle, array(CURLOPT_SSL_VERIFYHOST => false));
    // ruleid: php-tls-verify-off
    $client = new \GuzzleHttp\Client(['verify' => false]);
    // ruleid: php-tls-verify-off
    $client->request('GET', 'https://example.test', ['verify' => false]);
    // ok: php-tls-verify-off
    curl_setopt($handle, CURLOPT_SSL_VERIFYPEER, true);
    // ok: php-tls-verify-off
    curl_setopt($handle, CURLOPT_SSL_VERIFYHOST, 2);
    // ok: php-tls-verify-off
    curl_setopt_array($handle, [CURLOPT_SSL_VERIFYPEER => true, CURLOPT_SSL_VERIFYHOST => 2]);
    // ok: php-tls-verify-off
    $client->request('GET', 'https://example.test', ['verify' => true]);
    // ok: php-tls-verify-off
    $client->request('GET', 'https://example.test', ['verify' => '/etc/ssl/internal-ca.pem']);
}

class MassAssignmentCandidates {
    public function create($model) {
        $data = $this->request->getPost();
        // ruleid: php-phalcon-mass-assignment
        $model->assign($data);
        // ruleid: php-phalcon-mass-assignment
        $model->save($this->request->getJsonRawBody(true));
        // ruleid: php-phalcon-mass-assignment
        $model->create($_POST);
        // ok: php-phalcon-mass-assignment
        $model->assign($data, null, ['name', 'avatar']);
        // ok: php-phalcon-mass-assignment
        $model->save($data, ['name']);
        // ok: php-phalcon-mass-assignment
        $model->save(['name' => $this->request->getPost('name')]);
        // ok: php-phalcon-mass-assignment
        $model->assign(['name' => $_POST['name']]);
        // ok: php-phalcon-mass-assignment
        $model->assign(array_intersect_key($data, ['name' => 1]));
        // ok: php-phalcon-mass-assignment
        $model->assign($this->cache->get('row'));
    }
}

class LooseCompareCandidates {
    public function check($rows) {
        $uid = $this->request->getQuery('uid');
        // ruleid: php-loose-compare-input
        if ($uid == 0) {}
        // ruleid: php-loose-compare-input
        if ($this->request->getPost('level') != null) {}
        // ruleid: php-loose-compare-input
        if (in_array($_GET['id'], [1, 2, 3])) {}
        // ruleid: php-loose-compare-input
        if ($_POST['flag'] == true) {}
        // ok: php-loose-compare-input
        if ($this->request->getPost('mode', 'string', '') == 'auto') {}
        // ok: php-loose-compare-input
        if ($this->request->getPost('confirm', 'int', 0) != 1) {}
        // ok: php-loose-compare-input
        if ((int) $uid == 0) {}
        // ok: php-loose-compare-input
        if ($uid === '0') {}
        // ok: php-loose-compare-input
        if (in_array($_GET['id'], [1, 2, 3], true)) {}
        // ok: php-loose-compare-input
        if ($rows['a'] == 0) {}
        $hide = $this->request->getPost('hide', 'int', 0);
        // ok: php-loose-compare-input
        if ($hide == 1) {}
        // ok: php-loose-compare-input
        if ($uid != $rows['uid']) {}
        // ok: php-loose-compare-input
        if (in_array($this->request->getPost('type'), ['self', 'friend'])) {}
        // ruleid: php-loose-compare-input
        if (in_array($this->request->getPost('type'), ['a' => 1])) {}
        $allowed = ($_GET['package'] == 'com.example.app' && $rows['v'] >= 2);
        // ponytail: taint flows through == and && into a bool. Assignment-only propagation also drops $_POST['x'], so triage removes this case.
        // todook: php-loose-compare-input
        if ($allowed == false) {}
        $data = $this->request->getPost();
        // ruleid: php-loose-compare-input
        if ($data['vote'] == 2) {}
    }
}

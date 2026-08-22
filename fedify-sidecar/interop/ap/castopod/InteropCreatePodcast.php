<?php

declare(strict_types=1);

namespace App\Commands;

use App\Entities\Podcast;
use App\Models\PodcastModel;
use CodeIgniter\CLI\BaseCommand;
use CodeIgniter\CLI\CLI;
use CodeIgniter\Files\File;
use RuntimeException;

final class InteropCreatePodcast extends BaseCommand
{
    protected $group = 'Interop';
    protected $name = 'interop:create-podcast';
    protected $description = 'Creates the real podcast actor used by the local federation proof.';

    public function run(array $params): void
    {
        if (getenv('AP_INTEROP_CASTOPOD_BOOTSTRAP') !== '1') {
            throw new RuntimeException('Interop bootstrap authority is disabled.');
        }

        $handle = getenv('AP_INTEROP_CASTOPOD_HANDLE') ?: 'interop';
        if (preg_match('/^[a-z0-9_]{1,32}$/D', $handle) !== 1) {
            throw new RuntimeException('Invalid interop podcast handle.');
        }

        $podcastModel = new PodcastModel();
        if ($podcastModel->where('handle', $handle)->countAllResults() > 0) {
            CLI::write('Castopod federation target already exists.');
            return;
        }

        $user = model('UserModel')->where('username', 'interop-admin')->first();
        if ($user === null || ! is_numeric($user->id)) {
            throw new RuntimeException('Interop superadmin is missing.');
        }

        $coverPath = WRITEPATH . 'temp/interop-cover.png';
        $image = imagecreatetruecolor(1400, 1400);
        if ($image === false) {
            throw new RuntimeException('Unable to allocate the interop cover image.');
        }
        $background = imagecolorallocate($image, 25, 52, 79);
        imagefill($image, 0, 0, $background);
        if (! imagepng($image, $coverPath, 9)) {
            imagedestroy($image);
            throw new RuntimeException('Unable to write the interop cover image.');
        }
        imagedestroy($image);

        try {
            $podcast = new Podcast([
                'created_by' => (int) $user->id,
                'updated_by' => (int) $user->id,
                'title' => 'Interop Federation Podcast',
                'handle' => $handle,
                'cover' => new File($coverPath, true),
                'description_markdown' => 'Real Castopod federation target.',
                'language_code' => 'en',
                'category_id' => 1,
                'owner_name' => 'Interop',
                'owner_email' => 'interop@castopod.org',
                'is_owner_email_removed_from_feed' => true,
                'type' => 'episodic',
                'is_locked' => false,
                'published_at' => gmdate('Y-m-d H:i:s'),
            ]);
            $id = $podcastModel->insert($podcast, true);
            if (! is_numeric($id) || (int) $id < 1) {
                throw new RuntimeException('Castopod podcast creation failed: ' . json_encode($podcastModel->errors()));
            }
        } finally {
            @unlink($coverPath);
        }

        CLI::write('Created real Castopod podcast actor.');
    }
}
